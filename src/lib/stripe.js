import dotenv from "dotenv";
dotenv.config(); // ✅ GUARANTEED env load

import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Loaded env keys:", Object.keys(process.env));
  throw new Error("❌ STRIPE_SECRET_KEY is missing from environment variables");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default stripe;
