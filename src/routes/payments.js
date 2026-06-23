import express from "express";
import stripe from "../lib/stripe.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

//
// ==========================
// STRIPE WEBHOOK (CRITICAL)
// ==========================
//
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("❌ Invalid webhook signature:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ✅ Only handle successful payments
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const eventId = event.id;

      const user_profile_id = session.metadata.user_profile_id;
      const credits = Number(session.metadata.credits || 0);
      const bonus = Number(session.metadata.bonus_credits || 0);
      const totalCredits = credits + bonus;

      try {
        // 🔒 STEP 1: Check if already processed
        const { data: existing } = await supabase
          .from("stripe_events")
          .select("id")
          .eq("id", eventId)
          .maybeSingle();

        if (existing) {
          console.log("⚠️ Event already processed:", eventId);
          return res.json({ received: true });
        }

        // 💰 STEP 2: Add credits
        const { error: creditError } = await supabase.rpc("add_credits", {
          p_user_id: user_profile_id,
          p_amount: totalCredits,
        });

        if (creditError) throw creditError;

        // 🧾 STEP 3: Save event (prevents duplicates)
        const { error: insertError } = await supabase
          .from("stripe_events")
          .insert([{ id: eventId }]);

        if (insertError) throw insertError;

        console.log(
          `✅ Credits added: ${totalCredits} to user ${user_profile_id}`,
        );
      } catch (err) {
        console.error("❌ Webhook processing error:", err);
        return res.status(500).json({ error: "Webhook failed" });
      }
    }

    res.json({ received: true });
  },
);

//
// ==========================
// CREATE CHECKOUT SESSION
// ==========================
//
router.post("/create-session", async (req, res) => {
  try {
    const { user_profile_id, package_id } = req.body;

    if (!user_profile_id || !package_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ✅ Fetch package
    const { data: pkg, error } = await supabase
      .from("credit_packages")
      .select("*")
      .eq("id", package_id)
      .eq("active", true)
      .single();

    if (error || !pkg) {
      return res.status(404).json({ error: "Package not found" });
    }

    const amount = Math.round(Number(pkg.price_usd) * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: pkg.name,
              description: `${pkg.credits} credits${
                pkg.bonus_credits ? ` + ${pkg.bonus_credits} bonus` : ""
              }`,
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        user_profile_id,
        package_id: pkg.id,
        credits: pkg.credits,
        bonus_credits: pkg.bonus_credits || 0,
      },
      success_url:
        "https://strippals.com/credits?success=true&session_id={CHECKOUT_SESSION_ID}",

      cancel_url: "https://strippals.com/credits?canceled=true",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe session error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

export default router;
