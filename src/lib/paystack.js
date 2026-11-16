// ==========================================
// PAYSTACK API CLIENT (server-only)
// ==========================================
// Docs: https://paystack.com/docs/api/transaction/
// - Initialize: POST /transaction/initialize (amount in subunits)
// - Verify:     GET  /transaction/verify/:reference
// - Webhooks are signed with HMAC-SHA512 of the raw body using the
//   secret key, sent in the x-paystack-signature header.
//
// Unlike src/lib/stripe.js this never throws at import time, so the
// whole API keeps running if the key is not configured yet.

import crypto from "crypto";

const PAYSTACK_API = "https://api.paystack.co";

export function getPaystackSecret() {
  return process.env.PAYSTACK_SECRET_KEY || "";
}

export function isPaystackConfigured() {
  return getPaystackSecret().startsWith("sk_");
}

async function paystackRequest(path, { method = "GET", body } = {}) {
  const secret = getPaystackSecret();
  if (!secret) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  const res = await fetch(`${PAYSTACK_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const json = await res.json().catch(() => null);

  // `status` on the response is the API call result, not the payment's.
  if (!res.ok || !json?.status) {
    const err = new Error(json?.message || `Paystack request failed (${res.status})`);
    err.httpStatus = res.status;
    throw err;
  }

  return json.data;
}

export function initializeTransaction(payload) {
  return paystackRequest("/transaction/initialize", {
    method: "POST",
    body: payload,
  });
}

export function verifyTransaction(reference) {
  return paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
}

// Constant-time check that a webhook really came from Paystack.
export function isValidWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;

  const expected = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Map Paystack's transaction status (data.status from verify) to ours.
// https://paystack.com/docs/payments/verify-payments/#transaction-statuses
export function mapPaystackStatus(status) {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "abandoned":
      return "abandoned";
    case "reversed":
      return "reversed";
    case "ongoing":
    case "pending":
    case "processing":
    case "queued":
      return "pending";
    default:
      return "pending";
  }
}

// USD subunits (cents). Paystack's USD minimum is $2.00.
export const MIN_AMOUNT_SUBUNIT = { USD: 200, NGN: 5000 };

export function toSubunit(price) {
  return Math.round(Number(price) * 100);
}

export function newReference() {
  return `sp_${crypto.randomUUID().replace(/-/g, "")}`;
}
