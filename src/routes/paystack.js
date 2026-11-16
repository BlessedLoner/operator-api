// ==========================================
// PAYSTACK CHECKOUT ROUTES  (/payments/paystack/*)
// ==========================================
// Flow:
//   1. POST /initialize  (signed-in user) -> we price the package from the
//      database, save a payment row and get an access_code from Paystack.
//   2. The browser opens Paystack's popup with that access_code.
//   3. GET /verify/:reference (signed-in user) and POST /webhook (Paystack)
//      both re-check the payment with Paystack's verify API and grant
//      credits through grant_payment_credits(), which credits each
//      reference at most once.
// A browser redirect or "success" callback is never trusted on its own.

import express from "express";
import {
  initializeTransaction,
  verifyTransaction,
  isValidWebhookSignature,
  isPaystackConfigured,
  getPaystackSecret,
  mapPaystackStatus,
  MIN_AMOUNT_SUBUNIT,
  toSubunit,
  newReference,
} from "../lib/paystack.js";

const PAYMENT_UNAVAILABLE = "Payments are temporarily unavailable. Please try again later.";

// Decide what a verified Paystack transaction means for our payment row and
// grant credits when it's a matching success. Shared by /verify and /webhook.
export async function settlePayment({ supabase, row, data }) {
  if (!data || data.reference !== row.reference) {
    return "mismatch";
  }

  const status = mapPaystackStatus(data.status);

  if (status === "success") {
    const { data: result, error } = await supabase.rpc("grant_payment_credits", {
      p_reference: row.reference,
      p_amount_subunit: Number(data.amount),
      p_currency: String(data.currency || ""),
      p_provider_transaction_id: data.id ?? null,
      p_verification: {
        status: data.status,
        amount: data.amount,
        currency: data.currency,
        paid_at: data.paid_at ?? null,
        channel: data.channel ?? null,
        gateway_response: data.gateway_response ?? null,
      },
    });

    if (error) throw error;

    if (result === "credited" || result === "already_credited") {
      return "success";
    }
    return result === "mismatch" ? "mismatch" : "failed";
  }

  // Record non-final and failed states, but never touch a credited row.
  await supabase
    .from("payment_transactions")
    .update({
      status,
      provider_transaction_id: data.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .is("credited_at", null);

  return status;
}

export function createPaystackRouter({
  supabase,
  verifySupabaseUser,
  getBearerToken,
  initializeLimiter,
}) {
  const router = express.Router();

  // Signed-in buyer from the Supabase access token (never from the body)
  async function requireBuyer(req, res, next) {
    try {
      const token = getBearerToken(req);
      const user = token ? await verifySupabaseUser(token) : null;
      if (!user) {
        return res.status(401).json({ error: "Please sign in again." });
      }

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!profile) {
        return res.status(404).json({ error: "User profile not found" });
      }

      req.buyer = { user, profileId: profile.id };
      next();
    } catch (err) {
      console.error("Paystack auth error:", err);
      res.status(500).json({ error: "Authentication failed" });
    }
  }

  async function getBalance(profileId) {
    const { data } = await supabase
      .from("credits")
      .select("balance")
      .eq("user_id", profileId)
      .maybeSingle();
    return data?.balance ?? null;
  }

  // ------------------------------------------
  // POST /initialize  { package_id }
  // ------------------------------------------
  const initializeHandlers = [requireBuyer];
  if (initializeLimiter) initializeHandlers.push(initializeLimiter);

  router.post("/initialize", ...initializeHandlers, async (req, res) => {
    if (!isPaystackConfigured()) {
      return res.status(503).json({ error: PAYMENT_UNAVAILABLE });
    }

    const { package_id } = req.body || {};
    if (!package_id) {
      return res.status(400).json({ error: "Missing package_id" });
    }

    const { user, profileId } = req.buyer;

    if (!user.email) {
      return res
        .status(400)
        .json({ error: "Add an email address to your account to pay." });
    }

    try {
      // Price and credits come from the database, never the browser.
      const { data: pkg, error: pkgError } = await supabase
        .from("credit_packages")
        .select("id, name, credits, bonus_credits, price_usd, active")
        .eq("id", package_id)
        .eq("active", true)
        .maybeSingle();

      if (pkgError || !pkg) {
        return res.status(404).json({ error: "Credit package not found" });
      }

      const currency = (process.env.PAYSTACK_CURRENCY || "USD").toUpperCase();
      const amount = toSubunit(pkg.price_usd);
      const credits = Number(pkg.credits || 0);
      const bonus = Number(pkg.bonus_credits || 0);
      const totalCredits = credits + bonus;

      if (!Number.isInteger(amount) || amount < (MIN_AMOUNT_SUBUNIT[currency] || 1)) {
        return res.status(400).json({ error: "Invalid package price" });
      }
      if (totalCredits <= 0) {
        return res.status(400).json({ error: "Invalid package" });
      }

      const reference = newReference();

      const { data: row, error: insertError } = await supabase
        .from("payment_transactions")
        .insert({
          reference,
          user_profile_id: profileId,
          auth_user_id: user.id,
          package_id: pkg.id,
          credits,
          bonus_credits: bonus,
          total_credits: totalCredits,
          amount_subunit: amount,
          currency,
        })
        .select("id")
        .single();

      if (insertError || !row) {
        console.error("Paystack: failed to save payment row:", insertError);
        return res.status(500).json({ error: PAYMENT_UNAVAILABLE });
      }

      let checkout;
      try {
        checkout = await initializeTransaction({
          email: user.email,
          amount,
          currency,
          reference,
          channels: ["card"],
          callback_url: process.env.PAYSTACK_CALLBACK_URL || undefined,
          // Neutral description: no product details on the checkout.
          metadata: {
            reference,
            custom_fields: [
              {
                display_name: "Item",
                variable_name: "item",
                value: `${totalCredits} credits`,
              },
            ],
          },
        });
      } catch (err) {
        console.error("Paystack initialize failed:", err.message);
        await supabase
          .from("payment_transactions")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        return res.status(502).json({ error: PAYMENT_UNAVAILABLE });
      }

      return res.json({
        reference,
        access_code: checkout.access_code,
        authorization_url: checkout.authorization_url,
        package: {
          id: pkg.id,
          name: pkg.name,
          total_credits: totalCredits,
          price: amount / 100,
          currency,
        },
      });
    } catch (err) {
      console.error("Paystack initialize error:", err);
      return res.status(500).json({ error: PAYMENT_UNAVAILABLE });
    }
  });

  // ------------------------------------------
  // GET /verify/:reference
  // ------------------------------------------
  router.get("/verify/:reference", requireBuyer, async (req, res) => {
    const { reference } = req.params;
    const { user, profileId } = req.buyer;

    try {
      const { data: row } = await supabase
        .from("payment_transactions")
        .select("*")
        .eq("reference", reference)
        .maybeSingle();

      // Same answer for "missing" and "someone else's" payment.
      if (!row || row.auth_user_id !== user.id) {
        return res.status(404).json({ error: "Payment not found" });
      }

      if (row.credited_at) {
        return res.json({
          status: "success",
          credits_added: row.total_credits,
          balance: await getBalance(profileId),
        });
      }

      if (!isPaystackConfigured()) {
        return res.status(503).json({ error: PAYMENT_UNAVAILABLE });
      }

      let data;
      try {
        data = await verifyTransaction(reference);
      } catch (err) {
        // Paystack can 400/404 a reference the popup never opened.
        console.warn("Paystack verify failed:", err.message);
        return res.json({ status: "pending", balance: await getBalance(profileId) });
      }

      const status = await settlePayment({ supabase, row, data });

      return res.json({
        status,
        credits_added: status === "success" ? row.total_credits : 0,
        balance: await getBalance(profileId),
      });
    } catch (err) {
      console.error("Paystack verify error:", err);
      return res.status(500).json({ error: "Could not check your payment yet." });
    }
  });

  // ------------------------------------------
  // POST /webhook   (raw body, see index.js)
  // ------------------------------------------
  router.post("/webhook", async (req, res) => {
    const secret = getPaystackSecret();
    const signature = req.headers["x-paystack-signature"];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;

    if (!secret || !isValidWebhookSignature(rawBody, signature, secret)) {
      return res.status(401).send("Invalid signature");
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid payload");
    }

    // Only successful charges grant credits; acknowledge everything else.
    if (event?.event !== "charge.success") {
      return res.sendStatus(200);
    }

    const reference = event.data?.reference;

    try {
      const { data: row } = await supabase
        .from("payment_transactions")
        .select("*")
        .eq("reference", reference)
        .maybeSingle();

      if (!row) {
        console.warn("Paystack webhook for unknown reference:", reference);
        return res.sendStatus(200);
      }

      if (row.credited_at) {
        return res.sendStatus(200);
      }

      // Never trust the webhook payload alone: ask Paystack again.
      const data = await verifyTransaction(reference);
      const status = await settlePayment({ supabase, row, data });
      console.log(`💳 Paystack webhook ${reference}: ${status}`);

      return res.sendStatus(200);
    } catch (err) {
      // Non-200 makes Paystack retry later.
      console.error("Paystack webhook error:", err);
      return res.sendStatus(500);
    }
  });

  return router;
}
