// Offline tests for the Paystack routes: fake Supabase + fake Paystack API.
// Run: npm test   (no network, no database, no real keys)
import crypto from "crypto";
import { createRequire } from "module";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${API_DIR}/package.json`);
const express = require("express");
const { createPaystackRouter, settlePayment } = await import(
  pathToFileURL(`${API_DIR}/src/routes/paystack.js`).href
);
const { isValidWebhookSignature } = await import(
  pathToFileURL(`${API_DIR}/src/lib/paystack.js`).href
);

const SECRET = "sk_test_fake_secret_for_offline_tests";
process.env.PAYSTACK_SECRET_KEY = SECRET;
process.env.PAYSTACK_CURRENCY = "USD";

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

// ---------------- fake database ----------------
const db = {
  user_profiles: [
    { id: "prof-alice", user_id: "auth-alice" },
    { id: "prof-bob", user_id: "auth-bob" },
  ],
  credit_packages: [
    { id: "pkg-25", name: "25 Credits", credits: 25, bonus_credits: 0, price_usd: 35, active: true },
    { id: "pkg-off", name: "Old", credits: 5, bonus_credits: 0, price_usd: 5, active: false },
  ],
  credits: [
    { user_id: "prof-alice", balance: 0 },
    { user_id: "prof-bob", balance: 0 },
  ],
  payment_transactions: [],
};
let addCreditsCalls = 0;

function table(name) {
  const filters = [];
  let op = "select";
  let payload = null;
  const q = {
    select() {
      return q;
    },
    eq(col, val) {
      filters.push((r) => r[col] === val);
      return q;
    },
    is(col, val) {
      filters.push((r) => (r[col] ?? null) === val);
      return q;
    },
    insert(row) {
      op = "insert";
      payload = row;
      return q;
    },
    update(patch) {
      op = "update";
      payload = patch;
      return q;
    },
    run() {
      const rows = db[name];
      if (op === "insert") {
        const row = {
          id: crypto.randomUUID(),
          status: "initialized",
          credited_at: null,
          ...payload,
        };
        rows.push(row);
        return [row];
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") matched.forEach((r) => Object.assign(r, payload));
      return matched;
    },
    maybeSingle() {
      return Promise.resolve({ data: q.run()[0] ?? null, error: null });
    },
    single() {
      const r = q.run()[0];
      return Promise.resolve({ data: r ?? null, error: r ? null : { message: "none" } });
    },
    then(resolve) {
      resolve({ data: q.run(), error: null });
    },
  };
  return q;
}

// Mirrors grant_payment_credits() in sql/2026-11-16_paystack_payments.sql
async function rpc(fn, args) {
  if (fn !== "grant_payment_credits") throw new Error("unexpected rpc " + fn);
  const tx = db.payment_transactions.find((r) => r.reference === args.p_reference);
  if (!tx) return { data: "not_found", error: null };
  if (tx.credited_at) return { data: "already_credited", error: null };
  if (
    args.p_amount_subunit !== tx.amount_subunit ||
    args.p_currency.toUpperCase() !== tx.currency.toUpperCase()
  ) {
    tx.status = "mismatch";
    return { data: "mismatch", error: null };
  }
  addCreditsCalls++;
  db.credits.find((c) => c.user_id === tx.user_profile_id).balance += tx.total_credits;
  tx.status = "success";
  tx.credited_at = new Date().toISOString();
  return { data: "credited", error: null };
}

const supabase = { from: table, rpc };

// ---------------- fake Paystack API ----------------
const paystackState = {}; // reference -> { status, amount, currency }
let lastInitBody = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.paystack.co")) return realFetch(url, opts);
  if (opts.headers?.Authorization !== `Bearer ${SECRET}`) {
    return new Response(JSON.stringify({ status: false, message: "bad key" }), { status: 401 });
  }
  if (u.endsWith("/transaction/initialize")) {
    lastInitBody = JSON.parse(opts.body);
    paystackState[lastInitBody.reference] = {
      status: "ongoing",
      amount: lastInitBody.amount,
      currency: lastInitBody.currency,
    };
    return new Response(
      JSON.stringify({
        status: true,
        data: { access_code: "AC_" + lastInitBody.reference, authorization_url: "https://checkout.example/x", reference: lastInitBody.reference },
      }),
    );
  }
  const m = u.match(/\/transaction\/verify\/(.+)$/);
  if (m) {
    const ref = decodeURIComponent(m[1]);
    const s = paystackState[ref];
    if (!s) return new Response(JSON.stringify({ status: false, message: "Transaction reference not found" }), { status: 400 });
    return new Response(
      JSON.stringify({ status: true, data: { id: 123456, reference: ref, paid_at: null, channel: "card", ...s } }),
    );
  }
  return new Response("{}", { status: 404 });
};

// ---------------- app under test ----------------
const tokens = { "tok-alice": { id: "auth-alice", email: "alice@example.com" }, "tok-bob": { id: "auth-bob", email: "bob@example.com" } };
const app = express();
app.use("/payments/paystack/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(
  "/payments/paystack",
  createPaystackRouter({
    supabase,
    verifySupabaseUser: async (t) => tokens[t] ?? null,
    getBearerToken: (req) => (req.headers.authorization || "").replace(/^Bearer /, "") || null,
  }),
);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/payments/paystack`;

const call = (path, { token, method = "GET", body, headers = {} } = {}) =>
  realFetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && typeof body !== "string" ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const webhook = (event, secret = SECRET) => {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  return call("/webhook", {
    method: "POST",
    body: raw,
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
  });
};
const balance = (p) => db.credits.find((c) => c.user_id === p).balance;

try {
  console.log("\nSignature check");
  const raw = Buffer.from('{"a":1}');
  const good = crypto.createHmac("sha512", SECRET).update(raw).digest("hex");
  check("valid signature accepted", isValidWebhookSignature(raw, good, SECRET));
  check("wrong signature rejected", !isValidWebhookSignature(raw, "00" + good.slice(2), SECRET));
  check("missing signature rejected", !isValidWebhookSignature(raw, undefined, SECRET));

  console.log("\nUnauthorized requests");
  let r = await call("/initialize", { method: "POST", body: { package_id: "pkg-25" } });
  check("initialize without login -> 401", r.status === 401);
  r = await call("/initialize", { method: "POST", token: "tok-forged", body: { package_id: "pkg-25" } });
  check("initialize with invalid token -> 401", r.status === 401);
  r = await call("/verify/anything");
  check("verify without login -> 401", r.status === 401);

  console.log("\nInitialize uses server-side price");
  r = await call("/initialize", { method: "POST", token: "tok-alice", body: { package_id: "pkg-25", price: 0.01, credits: 99999 } });
  check("initialize ok", r.status === 200 && r.json.access_code);
  check("amount from DB ($35 -> 3500 cents), not body", lastInitBody.amount === 3500 && lastInitBody.currency === "USD");
  check("card channel only", JSON.stringify(lastInitBody.channels) === '["card"]');
  const refA = r.json.reference;
  const rowA = db.payment_transactions.find((x) => x.reference === refA);
  check("payment row saved with 25 credits", rowA && rowA.total_credits === 25 && rowA.user_profile_id === "prof-alice");
  r = await call("/initialize", { method: "POST", token: "tok-alice", body: { package_id: "pkg-off" } });
  check("inactive package -> 404", r.status === 404);
  r = await call("/initialize", { method: "POST", token: "tok-alice", body: {} });
  check("missing package -> 400", r.status === 400);

  console.log("\nPending payment");
  r = await call(`/verify/${refA}`, { token: "tok-alice" });
  check("ongoing -> pending, no credits", r.json.status === "pending" && balance("prof-alice") === 0);

  console.log("\nInvalid / foreign reference");
  r = await call("/verify/sp_doesnotexist", { token: "tok-alice" });
  check("unknown reference -> 404", r.status === 404);
  r = await call(`/verify/${refA}`, { token: "tok-bob" });
  check("another user's reference -> 404", r.status === 404);

  console.log("\nSuccessful payment, then duplicates");
  paystackState[refA].status = "success";
  r = await call(`/verify/${refA}`, { token: "tok-alice" });
  check("verify -> success", r.json.status === "success");
  check("25 credits added", balance("prof-alice") === 25);
  r = await call(`/verify/${refA}`, { token: "tok-alice" });
  check("second verify -> success, no extra credits", r.json.status === "success" && balance("prof-alice") === 25);
  r = await webhook({ event: "charge.success", data: { reference: refA } });
  check("webhook after verify -> 200", r.status === 200);
  r = await webhook({ event: "charge.success", data: { reference: refA } });
  check("webhook retry -> 200", r.status === 200);
  check("still exactly 25 credits after retries", balance("prof-alice") === 25 && addCreditsCalls === 1);

  console.log("\nConcurrent duplicate callbacks");
  r = await call("/initialize", { method: "POST", token: "tok-bob", body: { package_id: "pkg-25" } });
  const refB = r.json.reference;
  paystackState[refB].status = "success";
  await Promise.all([
    webhook({ event: "charge.success", data: { reference: refB } }),
    webhook({ event: "charge.success", data: { reference: refB } }),
    call(`/verify/${refB}`, { token: "tok-bob" }),
  ]);
  check("bob credited exactly once (25)", balance("prof-bob") === 25);

  console.log("\nForged webhook");
  r = await call("/initialize", { method: "POST", token: "tok-bob", body: { package_id: "pkg-25" } });
  const refC = r.json.reference;
  r = await webhook({ event: "charge.success", data: { reference: refC } }, "sk_test_wrong");
  check("bad signature -> 401", r.status === 401);
  r = await call("/webhook", { method: "POST", body: JSON.stringify({ event: "charge.success", data: { reference: refC } }), headers: { "Content-Type": "application/json" } });
  check("no signature -> 401", r.status === 401);
  check("no credits from forged webhook", balance("prof-bob") === 25);
  r = await webhook({ event: "charge.success", data: { reference: refC } });
  check("genuine webhook but payment not successful -> no credits", r.status === 200 && balance("prof-bob") === 25);

  console.log("\nWrong amount");
  paystackState[refC] = { status: "success", amount: 100, currency: "USD" };
  r = await call(`/verify/${refC}`, { token: "tok-bob" });
  check("underpaid -> mismatch", r.json.status === "mismatch");
  check("no credits for underpayment", balance("prof-bob") === 25);
  r = await call("/initialize", { method: "POST", token: "tok-bob", body: { package_id: "pkg-25" } });
  const refD = r.json.reference;
  paystackState[refD] = { status: "success", amount: 3500, currency: "NGN" };
  r = await call(`/verify/${refD}`, { token: "tok-bob" });
  check("wrong currency -> mismatch, no credits", r.json.status === "mismatch" && balance("prof-bob") === 25);

  console.log("\nFailed and cancelled payments");
  r = await call("/initialize", { method: "POST", token: "tok-alice", body: { package_id: "pkg-25" } });
  const refE = r.json.reference;
  paystackState[refE].status = "failed";
  r = await call(`/verify/${refE}`, { token: "tok-alice" });
  check("declined -> failed, no credits", r.json.status === "failed" && balance("prof-alice") === 25);
  r = await call("/initialize", { method: "POST", token: "tok-alice", body: { package_id: "pkg-25" } });
  const refF = r.json.reference;
  paystackState[refF].status = "abandoned";
  r = await call(`/verify/${refF}`, { token: "tok-alice" });
  check("cancelled checkout -> abandoned, no credits", r.json.status === "abandoned" && balance("prof-alice") === 25);

  console.log("\nsettlePayment guards");
  const s = await settlePayment({ supabase, row: { id: "x", reference: "sp_a" }, data: { reference: "sp_b", status: "success" } });
  check("reference mismatch never credits", s === "mismatch");

  console.log("\nNot configured");
  delete process.env.PAYSTACK_SECRET_KEY;
  r = await call("/initialize", { method: "POST", token: "tok-alice", body: { package_id: "pkg-25" } });
  check("no secret key -> 503, API keeps running", r.status === 503);
  r = await webhook({ event: "charge.success", data: { reference: refA } });
  check("no secret key -> webhook rejected", r.status === 401);
} catch (err) {
  failed++;
  console.error("Test crashed:", err);
} finally {
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
