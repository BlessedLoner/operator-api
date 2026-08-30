import express from "express";
import stripe from "../lib/stripe.js";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ==========================================
// AUTHENTICATE SUPABASE USER FROM BEARER TOKEN
// ==========================================
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      user: null,
      error: "Missing or invalid Authorization header",
    };
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return {
      user: null,
      error: "Missing access token",
    };
  }

  try {
    // Use Supabase Auth to validate the user's access token.
    // The service-role client is NOT used to trust the browser.
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error("❌ Supabase authentication failed:", error);

      return {
        user: null,
        error: "Invalid or expired authentication token",
      };
    }

    return {
      user,
      error: null,
    };
  } catch (err) {
    console.error("❌ Authentication error:", err);

    return {
      user: null,
      error: "Authentication failed",
    };
  }
}

router.get("/debug-stripe-account", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();

    return res.json({
      success: true,
      account_id: account.id,
      livemode: account.livemode,
      country: account.country,
      default_currency: account.default_currency,
    });
  } catch (err) {
    console.error("Stripe account debug error:", err);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


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
// ==========================================
// CREATE PAYMENT INTENT
// ==========================================
// New custom payment-page flow.
// This does NOT replace /create-session yet.
//
router.post("/create-payment-intent", async (req, res) => {
  try {
    const { package_id } = req.body;

    // ------------------------------------------
    // STEP 1: Validate package ID
    // ------------------------------------------
    if (!package_id) {
      return res.status(400).json({
        error: "Missing package_id",
      });
    }

    // ------------------------------------------
    // STEP 2: Authenticate the Supabase user
    // ------------------------------------------
    const { user, error: authError } = await getAuthenticatedUser(req);

    if (authError || !user) {
      return res.status(401).json({
        error: authError || "Unauthorized",
      });
    }

    console.log("💳 Creating PaymentIntent for auth user:", user.id);

    // ------------------------------------------
    // STEP 3: Find this user's profile
    // ------------------------------------------
    const { data: profile, error: profileError } = await supabase
      .from("user_profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (profileError || !profile) {
      console.error("❌ User profile not found:", {
        authUserId: user.id,
        error: profileError,
      });

      return res.status(404).json({
        error: "User profile not found",
      });
    }

    console.log("👤 Payment profile:", profile.id);

    // ------------------------------------------
    // STEP 4: Get package FROM DATABASE
    // ------------------------------------------
    // IMPORTANT:
    // We do NOT trust the frontend for:
    // - price
    // - credits
    // - bonus credits
    //
    // The database is the source of truth.
    // ------------------------------------------
    const { data: pkg, error: packageError } = await supabase
      .from("credit_packages")
      .select(
        "id, name, credits, bonus_credits, price_usd, active",
      )
      .eq("id", package_id)
      .eq("active", true)
      .single();

    if (packageError || !pkg) {
      console.error("❌ Credit package not found:", {
        package_id,
        error: packageError,
      });

      return res.status(404).json({
        error: "Credit package not found or inactive",
      });
    }

    // ------------------------------------------
    // STEP 5: Calculate Stripe amount
    // ------------------------------------------
    const price = Number(pkg.price_usd);

    if (!Number.isFinite(price) || price <= 0) {
      console.error("❌ Invalid package price:", pkg);

      return res.status(400).json({
        error: "Invalid credit package price",
      });
    }

    const amount = Math.round(price * 100);

    if (amount < 50) {
      return res.status(400).json({
        error: "Payment amount is below Stripe's minimum allowed amount",
      });
    }

    const totalCredits =
      Number(pkg.credits || 0) + Number(pkg.bonus_credits || 0);

    if (totalCredits <= 0) {
      return res.status(400).json({
        error: "Invalid credit package amount",
      });
    }

    console.log("💰 Payment package:", {
      packageId: pkg.id,
      name: pkg.name,
      priceUsd: price,
      stripeAmount: amount,
      credits: pkg.credits,
      bonusCredits: pkg.bonus_credits || 0,
      totalCredits,
    });

    // ------------------------------------------
    // STEP 6: Create Stripe PaymentIntent
    // ------------------------------------------
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",

      automatic_payment_methods: {
        enabled: true,
      },

      metadata: {
        user_profile_id: profile.id,
        auth_user_id: user.id,
        package_id: pkg.id,
        credits: String(pkg.credits || 0),
        bonus_credits: String(pkg.bonus_credits || 0),
        total_credits: String(totalCredits),
      },

      description: `${pkg.name} - ${totalCredits} credits`,
    });

    console.log("✅ PaymentIntent created:", paymentIntent.id);

    // ------------------------------------------
    // STEP 7: Return only what frontend needs
    // ------------------------------------------
    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,

      paymentIntentId: paymentIntent.id,

      package: {
        id: pkg.id,
        name: pkg.name,
        credits: pkg.credits,
        bonus_credits: pkg.bonus_credits || 0,
        total_credits: totalCredits,
        price_usd: price,
      },
    });
  } catch (err) {
    console.error("❌ Create PaymentIntent error:", err);

    return res.status(500).json({
      error: "Failed to create payment",
    });
  }
});



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
