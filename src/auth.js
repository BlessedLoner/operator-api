// ==========================================
// AUTHENTICATION / AUTHORIZATION MIDDLEWARE
// ==========================================
//
// - Operators: HS256 JWT issued by POST /operator/login, signed with
//   OPERATOR_JWT_SECRET. Every request re-checks the account is active.
// - Managers / admins: Supabase Auth access token (Bearer), verified with
//   supabase.auth.getUser(), then matched to an active `managers` row.
// - Site admins (/admin/*): Supabase Auth token whose user is an admin
//   manager OR has user_profiles.role = 'admin'.
//
// Identity is ALWAYS taken from the verified token, never from the body,
// query string or custom headers.

import jwt from "jsonwebtoken";

const OPERATOR_TOKEN_TTL = "12h";

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// Express 5 re-parses req.query on every access, so to force a value we
// shadow the getter with an own property on this request.
function forceQueryValue(req, key, value) {
  const query = { ...req.query, [key]: value };
  Object.defineProperty(req, "query", {
    value: query,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function createAuth(supabase) {
  const operatorSecret = process.env.OPERATOR_JWT_SECRET;
  if (!operatorSecret || operatorSecret.length < 32) {
    console.error(
      "🚨 OPERATOR_JWT_SECRET is missing or shorter than 32 chars - operator login is disabled",
    );
  }

  // ---------------- OPERATORS ----------------

  function signOperatorToken(operator) {
    if (!operatorSecret || operatorSecret.length < 32) {
      throw new Error("Operator authentication is not configured");
    }
    return jwt.sign(
      { sub: operator.id, typ: "operator" },
      operatorSecret,
      { algorithm: "HS256", expiresIn: OPERATOR_TOKEN_TTL },
    );
  }

  async function requireOperator(req, res, next) {
    try {
      const token = getBearerToken(req);
      if (!token || !operatorSecret) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let payload;
      try {
        payload = jwt.verify(token, operatorSecret, { algorithms: ["HS256"] });
      } catch {
        return res.status(401).json({ error: "Session expired" });
      }
      if (payload.typ !== "operator" || !payload.sub) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { data: operator, error } = await supabase
        .from("operator_accounts")
        .select("id, username, role, operator_type, is_active")
        .eq("id", payload.sub)
        .single();

      if (error || !operator || !operator.is_active) {
        return res.status(401).json({ error: "Account not active" });
      }

      req.operator = operator;
      req.operatorId = operator.id;

      // Legacy handlers read operator_id from body/query: overwrite it with
      // the verified id so a client cannot act as another operator.
      if (req.body && typeof req.body === "object") {
        req.body.operator_id = operator.id;
      }
      forceQueryValue(req, "operator_id", operator.id);

      next();
    } catch (err) {
      console.error("requireOperator error:", err);
      res.status(500).json({ error: "Authentication failed" });
    }
  }

  // ---------------- SUPABASE USERS ----------------

  // Short cache so every manager page load isn't several Auth round trips.
  const userCache = new Map(); // token -> { user, expires }
  const CACHE_MS = 30 * 1000;

  async function verifySupabaseUser(token) {
    const cached = userCache.get(token);
    if (cached && cached.expires > Date.now()) return cached.user;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;

    if (userCache.size > 500) userCache.clear();
    userCache.set(token, { user: data.user, expires: Date.now() + CACHE_MS });
    return data.user;
  }

  // ---------------- MANAGERS ----------------

  async function requireManager(req, res, next) {
    try {
      const token = getBearerToken(req);
      if (!token) return res.status(401).json({ error: "Not authenticated" });

      const user = await verifySupabaseUser(token);
      if (!user) return res.status(401).json({ error: "Session expired" });

      const { data: manager, error } = await supabase
        .from("managers")
        .select("id, user_id, username, full_name, email, role, is_active")
        .eq("user_id", user.id)
        .single();

      if (error || !manager) {
        return res.status(403).json({ error: "Not authorized as manager" });
      }
      if (!manager.is_active) {
        return res.status(401).json({ error: "Account disabled" });
      }

      req.authUser = user;
      req.manager = manager;
      next();
    } catch (err) {
      console.error("requireManager error:", err);
      res.status(500).json({ error: "Authentication failed" });
    }
  }

  // Use AFTER requireManager.
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.manager || !roles.includes(req.manager.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      next();
    };
  }

  const requireAdmin = [requireManager, requireRole("admin")];

  // ---------------- SITE ADMIN (/admin/*) ----------------

  async function requireSiteAdmin(req, res, next) {
    try {
      const token = getBearerToken(req);
      if (!token) return res.status(401).json({ error: "Not authenticated" });

      const user = await verifySupabaseUser(token);
      if (!user) return res.status(401).json({ error: "Session expired" });

      const { data: manager } = await supabase
        .from("managers")
        .select("role, is_active")
        .eq("user_id", user.id)
        .maybeSingle();

      let isAdmin = !!(manager && manager.is_active && manager.role === "admin");

      if (!isAdmin) {
        // NOTE: only safe once RLS stops users editing their own role.
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("role")
          .eq("user_id", user.id)
          .maybeSingle();
        isAdmin = profile?.role === "admin";
      }

      if (!isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }

      req.authUser = user;
      next();
    } catch (err) {
      console.error("requireSiteAdmin error:", err);
      res.status(500).json({ error: "Authentication failed" });
    }
  }

  return {
    signOperatorToken,
    requireOperator,
    requireManager,
    requireRole,
    requireAdmin,
    requireSiteAdmin,
    verifySupabaseUser,
    getBearerToken,
  };
}

// ==========================================
// SIMPLE IN-MEMORY RATE LIMITER (no dependency)
// ==========================================
export function rateLimit({ windowMs, max, key }) {
  const hits = new Map(); // key -> { count, reset }
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [hk, v] of hits) if (v.reset < now) hits.delete(hk);
    }
    if (entry.count > max) {
      res.set("Retry-After", Math.ceil((entry.reset - now) / 1000));
      return res
        .status(429)
        .json({ error: "Too many attempts. Please try again later." });
    }
    next();
  };
}

// ==========================================
// Escape a user value for use inside a PostgREST .or() filter string.
// Only letters, numbers, spaces and @ . - _ + ' are kept (filter syntax
// characters like , ( ) " \ * % are dropped), then the pattern is wrapped
// in double quotes so the dot is treated literally.
// Returns null when nothing searchable is left.
// ==========================================
export function orFilterLike(value) {
  const cleaned = String(value ?? "")
    .slice(0, 100)
    .replace(/[^\p{L}\p{N}\s@.\-_+']/gu, "")
    .trim();
  if (!cleaned) return null;
  return `"%${cleaned}%"`;
}
