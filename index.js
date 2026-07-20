import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import paymentsRouter from "./src/routes/payments.js";

dotenv.config();

const app = express();

app.use(cors());

// ✅ Stripe webhook MUST use raw body BEFORE json parser
app.use("/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log(
  "SERVICE_ROLE_KEY exists:",
  !!process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ✅ Supabase service-role client (server-only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ✅ Health check
app.get("/", (_req, res) => {
  res.send("Operator API running");
});

// Add middleware to check admin role
const requireAdmin = async (req, res, next) => {
  const managerId = req.headers["x-manager-id"];
  if (!managerId) return res.status(401).json({ error: "Unauthorized" });

  const { data: manager } = await supabase
    .from("managers")
    .select("role")
    .eq("id", managerId)
    .single();

  if (!manager || manager.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
};

// ==========================
// USER ROUTES
// ==========================
// User sends a message - using message_queue
app.post("/user/send-message", async (req, res) => {
  try {
    const { conversation_id, user_id, content, image_url } = req.body;

    // ✅ FIRST: Check if this conversation already has an ACTIVE assignment (within 5-min lock)
    const { data: existingAssignment, error: assignError } = await supabase
      .from("message_queue")
      .select("id, assigned_operator_id, status, expires_at")
      .eq("conversation_id", conversation_id)
      .eq("status", "assigned")
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();

    let isNewAssignment = false;
    let assignedOperatorId = null;

    if (existingAssignment) {
      // ✅ Conversation already assigned to an operator - just add message, NO new queue item
      assignedOperatorId = existingAssignment.assigned_operator_id;
      console.log(
        `📨 Message added to existing conversation assigned to operator ${assignedOperatorId}`,
      );

      // Just insert the message - no queue item creation
      const { data: message, error: msgError } = await supabase
        .from("messages")
        .insert({
          conversation_id,
          sender_type: "real_user",
          sender_user_id: user_id,
          content,
          image_url,
          direction: "user_to_fictional",
          credit_cost: 1,
          is_read: false,
        })
        .select()
        .single();

      if (msgError) throw msgError;

      // Update conversation last message
      await supabase
        .from("conversations")
        .update({
          last_message_at: message.created_at,
          last_message_sender_id: user_id,
          last_message_preview: content?.substring(0, 50) || "[Image]",
        })
        .eq("id", conversation_id);

      // Also refresh the expires_at to give more time
      const newExpiresAt = new Date();
      newExpiresAt.setMinutes(newExpiresAt.getMinutes() + 5);

      await supabase
        .from("message_queue")
        .update({ expires_at: newExpiresAt.toISOString() })
        .eq("id", existingAssignment.id);

      return res.json({
        success: true,
        message,
        assigned_operator_id: assignedOperatorId,
        is_new_assignment: false,
      });
    }

    await supabase
      .from("stopped_queue")
      .update({
        status: "cancelled",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("conversation_id", conversation_id)
      .in("status", ["pending", "assigned"]);

    // ❌ No active assignment - check for ANY active queue row
    const { data: activeQueue } = await supabase
      .from("message_queue")
      .select("*")
      .eq("conversation_id", conversation_id)
      .in("status", ["pending", "assigned"])
      .maybeSingle();

    // Insert the message
    const { data: message, error: msgError } = await supabase
      .from("messages")
      .insert({
        conversation_id,
        sender_type: "real_user",
        sender_user_id: user_id,
        content,
        image_url,
        direction: "user_to_fictional",
        credit_cost: 1,
        is_read: false,
      })
      .select()
      .single();

    if (msgError) throw msgError;

    // Update conversation
    await supabase
      .from("conversations")
      .update({
        last_message_at: message.created_at,
        last_message_sender_id: user_id,
        last_message_preview: content?.substring(0, 50) || "[Image]",
      })
      .eq("id", conversation_id);

    // ACTIVE QUEUE EXISTS
    if (activeQueue) {
      console.log(
        `📨 Existing active queue found for conversation ${conversation_id}`,
      );

      await supabase
        .from("message_queue")
        .update({
          message_id: message.id,
          message_count: (activeQueue.message_count || 1) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", activeQueue.id);

      return res.json({
        success: true,
        message,
        assigned_operator_id: activeQueue.assigned_operator_id || null,
        is_new_assignment: false,
      });
    }

    // NO ACTIVE QUEUE → CREATE NEW ONE
    isNewAssignment = true;

    console.log(
      `🆕 Creating new queue item for conversation ${conversation_id}`,
    );

    await supabase.from("message_queue").insert({
      conversation_id,
      message_id: message.id,
      status: "pending",
      conversation_assigned: false,
      message_count: 1,
      created_at: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message,
      assigned_operator_id: null,
      is_new_assignment: true,
    });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/shuffle-profiles", async (req, res) => {
  try {
    console.log("🔀 Starting profile shuffle...");

    const { data: profiles, error } = await supabase
      .from("fictional_profiles")
      .select("id");

    if (error) throw error;

    for (const profile of profiles) {
      const randomOrder = Math.floor(Math.random() * 1000000);

      const { error: updateError } = await supabase
        .from("fictional_profiles")
        .update({
          shuffle_order: randomOrder,
        })
        .eq("id", profile.id);

      if (updateError) {
        console.error(`❌ Failed updating profile ${profile.id}:`, updateError);
      }
    }

    console.log("✅ Profiles shuffled successfully");

    res.json({
      success: true,
      shuffled: profiles.length,
    });
  } catch (err) {
    console.error("❌ Shuffle error:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

// ==========================
// OPERATOR ROUTES
// ==========================

// Load conversations
app.get("/operator/conversations", async (req, res) => {
  const { data, error } = await supabase
    .from("conversations")
    .select(
      `
      id,
      created_at,
      user_profiles!conversations_user_id_fkey (
        id,
        display_name
      ),
      fictional_profiles (
        id,
        display_name
      )
    `,
    )
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Supabase error:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json(
    data.map((c) => ({
      conversation_id: c.id,
      created_at: c.created_at,
      user_profiles: c.user_profiles,
      fictional_profiles: c.fictional_profiles,
    })),
  );
});

// Get next conversation for regular operator
app.post("/operator/next-conversation", async (req, res) => {
  try {
    const { operator_id } = req.body;

    if (!operator_id) {
      return res.status(400).json({ error: "Missing operator_id" });
    }

    // Get operator type
    const { data: operator, error: opError } = await supabase
      .from("operator_accounts")
      .select("operator_type, is_active")
      .eq("id", operator_id)
      .single();

    if (opError || !operator) {
      return res.status(404).json({ error: "Operator not found" });
    }

    if (!operator.is_active) {
      return res.status(403).json({ error: "Account deactivated" });
    }

    if (operator.operator_type !== "regular") {
      return res.status(403).json({ error: "Not a regular operator" });
    }

    // Clean up expired assignments
    await supabase
      .from("message_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
        conversation_assigned: false,
      })
      .eq("status", "assigned")
      .lt("expires_at", new Date().toISOString());

    // Check if operator already has an active conversation
    const { data: existingAssignment } = await supabase
      .from("message_queue")
      .select("*")
      .eq("assigned_operator_id", operator_id)
      .eq("status", "assigned")
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();

    if (existingAssignment) {
      // Get conversation details
      const { data: conversation } = await supabase
        .from("conversations")
        .select(
          `
          *,
          user_profiles!conversations_user_id_fkey (*),
          fictional_profiles!conversations_fictional_profile_id_fkey (*)
        `,
        )
        .eq("id", existingAssignment.conversation_id)
        .single();

      const { data: messages } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", existingAssignment.conversation_id)
        .eq("is_read", false)
        .eq("sender_type", "real_user")
        .order("created_at", { ascending: true });

      return res.json({
        assigned: true,
        assignmentId: existingAssignment.id,
        conversationId: conversation.id,
        userProfile: conversation.user_profiles,
        fictionalProfile: conversation.fictional_profiles,
        messages: messages || [],
        expiresAt: existingAssignment.expires_at,
      });
    }

    // Get pending messages
    const { data: pendingMessages, error: pendingError } = await supabase
      .from("message_queue")
      .select(
        `
        *,
        conversations!inner (
          id,
          user_profiles!conversations_user_id_fkey (*),
          fictional_profiles!conversations_fictional_profile_id_fkey (*)
        )
      `,
      )
      .eq("status", "pending")
      .eq("conversation_assigned", false)
      .order("created_at", { ascending: true })
      .limit(1);

    if (pendingError) throw pendingError;

    if (!pendingMessages || pendingMessages.length === 0) {
      return res.json({
        assigned: false,
        message: "No conversations available",
      });
    }

    const selectedMessage = pendingMessages[0];

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const { data: updated, error: updateError } = await supabase
      .from("message_queue")
      .update({
        status: "assigned",
        assigned_operator_id: operator_id,
        assigned_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
        conversation_assigned: true,
      })
      .eq("id", selectedMessage.id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Mark all messages from this conversation as assigned
    await supabase
      .from("message_queue")
      .update({ conversation_assigned: true })
      .eq("conversation_id", selectedMessage.conversation_id)
      .eq("status", "pending");

    const { data: messages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", selectedMessage.conversation_id)
      .eq("is_read", false)
      .eq("sender_type", "real_user")
      .order("created_at", { ascending: true });

    res.json({
      assigned: true,
      assignmentId: updated.id,
      conversationId: selectedMessage.conversation_id,
      userProfile: selectedMessage.conversations.user_profiles,
      fictionalProfile: selectedMessage.conversations.fictional_profiles,
      messages: messages || [],
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error("Next conversation error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Load messages
app.get("/operator/conversations/:id/messages", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", id)
    .order("created_at");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Get next pending conversation for STOPPED operators only
app.get("/stopped/next-conversation", async (req, res) => {
  try {
    const { operator_id } = req.query;

    if (!operator_id) {
      return res.status(400).json({ error: "Missing operator_id" });
    }

    // ✅ Verify this is a STOPPED operator
    const { data: operator, error: opError } = await supabase
      .from("operator_accounts")
      .select("operator_type, is_active")
      .eq("id", operator_id)
      .single();

    if (opError || !operator) {
      return res.status(404).json({ error: "Operator not found" });
    }

    // ✅ ONLY stopped operators can use this endpoint
    if (operator.operator_type !== "stopped") {
      return res.status(403).json({
        error: "This endpoint is only for stopped operators",
        operator_type: operator.operator_type,
      });
    }

    // Get pending stopped conversations (inactive for 48+ hours)
    const { data: pending, error: pendingError } = await supabase
      .from("stopped_queue")
      .select(
        `
        *,
        user_profiles!inner (*),
        fictional_profiles!inner (*)
      `,
      )
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (pendingError) throw pendingError;

    if (!pending) {
      return res.json({
        hasConversation: false,
        message: "No stopped conversations available",
      });
    }

    // Assign to this operator with 5-minute lock
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);

    const { data: updated, error: updateError } = await supabase
      .from("stopped_queue")
      .update({
        status: "assigned",
        assigned_operator_id: operator_id,
        assigned_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq("id", pending.id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      hasConversation: true,
      queueId: updated.id,
      conversationId: updated.conversation_id,
      userProfile: pending.user_profiles,
      fictionalProfile: pending.fictional_profiles,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error("Stopped next conversation error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/operator/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    const { data: operator, error } = await supabase
      .from("operator_accounts")
      .select("*")
      .eq("username", username)
      .single();

    if (error || !operator) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Check if account is active
    if (!operator.is_active) {
      return res
        .status(401)
        .json({ error: "Account deactivated. Please contact support." });
    }

    const validPassword = await bcrypt.compare(
      password,
      operator.password_hash,
    );

    if (!validPassword) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Update last login
    await supabase
      .from("operator_accounts")
      .update({ last_login: new Date().toISOString() })
      .eq("id", operator.id);

    const { password_hash, ...safeOperator } = operator;

    // ✅ Include operator_type in the response
    res.json({
      id: operator.id,
      username: operator.username,
      role: operator.role,
      operator_type: operator.operator_type, // ✅ ADD THIS
      full_name: operator.full_name,
      email: operator.email,
    });
  } catch (err) {
    console.error("Operator login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// OPERATOR STATISTICS ENDPOINTS
// ==========================

// Get operator statistics (messages today, monthly, last 12 days)
app.get("/operator/stats", async (req, res) => {
  try {
    const operatorId = req.query.operator_id;
    if (!operatorId) {
      return res.status(400).json({ error: "Missing operator_id" });
    }

    console.log("📊 Fetching stats for operator:", operatorId);

    const now = new Date();

    // Reset time is 1am TODAY
    const todayReset = new Date(now);

    // If current time is before 1AM,
    // use PREVIOUS DAY 1AM as reset point
    if (now.getHours() < 1) {
      todayReset.setDate(todayReset.getDate() - 1);
    }

    todayReset.setHours(1, 0, 0, 0);

    const resetTimeUTC = todayReset.toISOString();

    // Get today's message count for THIS SPECIFIC operator
    const { count: messagesToday, error: todayError } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("sender_type", "fictional")
      .not("operator_id", "is", null)
      .eq("operator_id", operatorId) // ✅ FILTER BY OPERATOR
      .gte("created_at", resetTimeUTC);

    if (todayError) throw todayError;

    // Get current month message count for THIS operator
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    currentMonthStart.setHours(0, 0, 0, 0);
    const { count: currentMonth, error: currentError } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("sender_type", "fictional")

      .not("operator_id", "is", null)
      .eq("operator_id", operatorId) // ✅ FILTER BY OPERATOR
      .gte("created_at", currentMonthStart.toISOString());

    if (currentError) throw currentError;

    // Get last month message count for THIS operator
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    lastMonthStart.setHours(0, 0, 0, 0);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    lastMonthEnd.setHours(23, 59, 59, 999);

    const { count: lastMonth, error: lastError } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("sender_type", "fictional")
      .not("operator_id", "is", null)
      .eq("operator_id", operatorId) // ✅ FILTER BY OPERATOR
      .gte("created_at", lastMonthStart.toISOString())
      .lte("created_at", lastMonthEnd.toISOString());

    if (lastError) throw lastError;

    // Get last 12 days message activity for THIS operator
    const last12Days = [];
    for (let i = 11; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setDate(now.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const { count, error } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("sender_type", "fictional")
        .not("operator_id", "is", null)
        .eq("operator_id", operatorId) // ✅ FILTER BY OPERATOR
        .gte("created_at", dayStart.toISOString())
        .lte("created_at", dayEnd.toISOString());

      if (error) throw error;

      last12Days.push({
        date: dayStart.toISOString().split("T")[0],
        count: count || 0,
      });
    }

    // Get total processed messages for THIS operator
    const { count: processed, error: processedError } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("sender_type", "fictional")
      .not("operator_id", "is", null)
      .eq("operator_id", operatorId); // ✅ FILTER BY OPERATOR

    if (processedError) throw processedError;

    res.json({
      messagesToday: messagesToday || 0,
      currentMonth: currentMonth || 0,
      lastMonth: lastMonth || 0,
      last12Days,
      processed: processed || 0,
      pending: 0,
      operatorName: req.query.operator_name || "Operator",
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// OPERATOR QUEUE & DISTRIBUTION ENDPOINTS
// ==========================

// Get operator's current assigned message (for waiting room)
// Get operator's current assigned message (for waiting room)
app.get("/operator/current-message", async (req, res) => {
  try {
    const { operator_id, device_id } = req.query;

    if (!operator_id) {
      return res.status(400).json({ error: "Missing operator_id" });
    }

    // First, clean up any expired assignments for THIS operator
    const { data: expiredAssignments, error: expiredError } = await supabase
      .from("message_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("assigned_operator_id", operator_id)
      .eq("status", "assigned")
      .lt("expires_at", new Date().toISOString())
      .select();

    if (expiredError) {
      console.error("Expired cleanup error:", expiredError);
    } else if (expiredAssignments?.length > 0) {
      console.log(
        `🔄 Released ${expiredAssignments.length} expired assignments for operator ${operator_id}`,
      );

      // 🔥 CRITICAL FIX: Clear conversation ownership for expired assignments
      const conversationIds = expiredAssignments
        .map((m) => m.conversation_id)
        .filter(Boolean);
      if (conversationIds.length > 0) {
        await supabase
          .from("conversations")
          .update({
            active_operator_id: null,
            active_operator_device: null,
            active_operator_at: null,
          })
          .in("id", conversationIds);
        console.log(
          `✅ Cleared ownership for ${conversationIds.length} expired conversations`,
        );
      }
    }

    // Update operator session
    await supabase.from("operator_sessions").upsert({
      operator_id: operator_id,
      status: "online",
      last_heartbeat: new Date().toISOString(),
    });

    // Check if operator has an active assigned message
    const { data: queueItem, error: queueError } = await supabase
      .from("message_queue")
      .select(
        `
        *,
        conversations (
          id,
          user_profiles!conversations_user_id_fkey (
            id,
            display_name,
            age,
            gender,
            bio,
            city,
            country,
            state,
            height,
            body_type,
            eye_color,
            hair_color,
            marital_status,
            profile_img,
            interests
          ),
          fictional_profiles (
            id,
            display_name,
            name,
            age,
            bio,
            about,
            city,
            country,
            state,
            height,
            hair_color,
            eye_color,
            relationship,
            image_url,
            interests
          )
        )
      `,
      )
      .eq("assigned_operator_id", operator_id)
      .eq("status", "assigned")
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();

    if (queueError) {
      return res.status(500).json({ error: queueError.message });
    }

    if (queueItem) {
      // Refresh ownership for current active queue
      await supabase
        .from("conversations")
        .update({
          active_operator_id: operator_id,
          active_operator_device: req.query.device_id,
          active_operator_at: new Date().toISOString(),
        })
        .eq("id", queueItem.conversation_id);

      // Get the actual message content
      const { data: message, error: msgError } = await supabase
        .from("messages")
        .select("*")
        .eq("id", queueItem.message_id)
        .single();

      if (msgError) {
        return res.status(500).json({ error: msgError.message });
      }

      await supabase
        .from("conversations")
        .update({
          active_operator_id: operator_id,
          active_operator_device: device_id,
          active_operator_at: new Date().toISOString(),
        })
        .eq("id", queueItem.conversation_id);

      return res.json({
        hasMessage: true,
        queueId: queueItem.id,
        conversationId: queueItem.conversation_id,
        message: message,
        userProfile: queueItem.conversations.user_profiles,
        fictionalProfile: queueItem.conversations.fictional_profiles,
        expiresAt: queueItem.expires_at,
      });
    }

    return res.json({ hasMessage: false });
  } catch (err) {
    console.error("Current message error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/operator/assign-next", async (req, res) => {
  try {
    const { operator_id, device_id } = req.body;

    console.log("REQ BODY:", req.body);
    console.log("ASSIGN NEXT DEVICE:", device_id);

    if (!operator_id) {
      return res.status(400).json({ error: "Missing operator_id" });
    }

    // Get operator type and check if active
    const { data: operator, error: opError } = await supabase
      .from("operator_accounts")
      .select("operator_type, is_active")
      .eq("id", operator_id)
      .single();

    if (opError || !operator) {
      return res.status(404).json({ error: "Operator not found" });
    }

    if (!operator.is_active) {
      return res.status(403).json({ error: "Account deactivated" });
    }

    // ============================================
    // REGULAR OPERATOR - Get from message_queue
    // ============================================
    if (operator.operator_type === "regular") {
      // ✅ Clean up expired assignments (any operator)
      await supabase
        .from("message_queue")
        .update({
          status: "pending",
          assigned_operator_id: null,
          assigned_at: null,
          expires_at: null,
          conversation_assigned: false,
        })
        .eq("status", "assigned")
        .lt("expires_at", new Date().toISOString());

      // ✅ Also clean up orphaned records (assigned but no operator)
      await supabase
        .from("message_queue")
        .update({
          status: "pending",
          assigned_operator_id: null,
          assigned_at: null,
          expires_at: null,
          conversation_assigned: false,
        })
        .eq("status", "assigned")
        .is("assigned_operator_id", null);

      // Check if operator already has an assigned message
      const { data: existingAssigned } = await supabase
        .from("message_queue")
        .select("*")
        .eq("assigned_operator_id", operator_id)
        .eq("status", "assigned")
        .gte("expires_at", new Date().toISOString())
        .maybeSingle();

      if (existingAssigned) {
        // Get conversation details
        const { data: conversation } = await supabase
          .from("conversations")
          .select(
            `
            *,
            user_profiles!conversations_user_id_fkey (*),
            fictional_profiles!conversations_fictional_profile_id_fkey (*)
          `,
          )
          .eq("id", existingAssigned.conversation_id)
          .single();

        // Get all unread messages for this conversation
        const { data: messages } = await supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", existingAssigned.conversation_id)
          .eq("is_read", false)
          .eq("sender_type", "real_user")
          .order("created_at", { ascending: true });

        return res.json({
          assigned: true,
          type: "regular",
          queueId: existingAssigned.id,
          conversationId: conversation.id,
          allMessages: messages || [],
          userProfile: conversation.user_profiles,
          fictionalProfile: conversation.fictional_profiles,
          expiresAt: existingAssigned.expires_at,
        });
      }

      // Get all conversation IDs that are currently assigned (to exclude them)
      const { data: assignedConversations } = await supabase
        .from("message_queue")
        .select("conversation_id")
        .eq("status", "assigned")
        .gte("expires_at", new Date().toISOString());

      const assignedConvIds =
        assignedConversations?.map((c) => c.conversation_id) || [];

      // Build query for pending messages
      let query = supabase
        .from("message_queue")
        .select(
          `
          *,
          conversations!inner (
            id,
            user_profiles!conversations_user_id_fkey (*),
            fictional_profiles!conversations_fictional_profile_id_fkey (*)
          )
        `,
        )
        .eq("status", "pending")
        .eq("conversation_assigned", false)
        .order("created_at", { ascending: true })
        .limit(5); // Get a few to check

      // Exclude assigned conversations if any
      if (assignedConvIds.length > 0) {
        const idsString = assignedConvIds.map((id) => `${id}`).join(",");
        query = query.filter("conversation_id", "not.in", `(${idsString})`);
      }

      const { data: pendingMessages, error: pendingError } = await query;

      if (pendingError) {
        console.error("Pending error:", pendingError);
        return res.status(500).json({ error: pendingError.message });
      }

      if (!pendingMessages || pendingMessages.length === 0) {
        return res.json({ assigned: false, message: "No messages available" });
      }

      // Find first pending message whose conversation is not already assigned
      let selectedMessage = null;
      for (const msg of pendingMessages) {
        const { data: isAssigned } = await supabase
          .from("message_queue")
          .select("id")
          .eq("conversation_id", msg.conversation_id)
          .eq("status", "assigned")
          .gte("expires_at", new Date().toISOString())
          .maybeSingle();

        if (!isAssigned) {
          selectedMessage = msg;
          break;
        }
      }

      if (!selectedMessage) {
        return res.json({
          assigned: false,
          message: "No available conversations",
        });
      }

      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 5);

      // Assign this message to the operator
      const { data: updated, error: updateError } = await supabase
        .from("message_queue")
        .update({
          status: "assigned",
          assigned_operator_id: operator_id,
          assigned_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          conversation_assigned: true,
        })
        .eq("id", selectedMessage.id)
        .eq("status", "pending")
        .select()
        .single();

      if (updateError) throw updateError;

      // Save active operator/device ownership
      const { data: conversationUpdate, error: conversationUpdateError } =
        await supabase
          .from("conversations")
          .update({
            active_operator_id: operator_id,
            active_operator_device: device_id || null,
            active_operator_at: new Date().toISOString(),
          })
          .eq("id", selectedMessage.conversation_id)
          .select();

      console.log(
        "Conversation ownership update:",
        conversationUpdate,
        conversationUpdateError,
      );

      // Mark any other pending messages from the SAME conversation as conversation_assigned
      await supabase
        .from("message_queue")
        .update({ conversation_assigned: true })
        .eq("conversation_id", selectedMessage.conversation_id)
        .eq("status", "pending");

      // Get all unread messages for this conversation
      const { data: messages } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", selectedMessage.conversation_id)
        .eq("is_read", false)
        .eq("sender_type", "real_user")
        .order("created_at", { ascending: true });

      return res.json({
        assigned: true,
        type: "regular",
        queueId: updated.id,
        conversationId: selectedMessage.conversation_id,
        allMessages: messages || [],
        userProfile: selectedMessage.conversations.user_profiles,
        fictionalProfile: selectedMessage.conversations.fictional_profiles,
        expiresAt: expiresAt.toISOString(),
      });
    }

    // POKE OPERATOR - unchanged
    else if (operator.operator_type === "poke") {
      const { data: pendingUser, error: pendingError } = await supabase
        .from("poke_queue")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (pendingError) throw pendingError;

      if (!pendingUser) {
        return res.json({ assigned: false, message: "No new users available" });
      }

      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 5);

      const { data: updated, error: updateError } = await supabase
        .from("poke_queue")
        .update({
          status: "assigned",
          assigned_operator_id: operator_id,
          assigned_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .eq("id", pendingUser.id)
        .select()
        .single();

      if (updateError) throw updateError;

      const { data: userProfile } = await supabase
        .from("user_profiles")
        .select("*")
        .eq("id", pendingUser.user_profile_id)
        .single();

      const { data: fictionalProfile } = await supabase
        .from("fictional_profiles")
        .select("*")
        .eq("country", userProfile?.country)
        .limit(1)
        .maybeSingle();

      return res.json({
        assigned: true,
        type: "poke",
        queueId: updated.id,
        userProfile: userProfile,
        fictionalProfile: fictionalProfile,
        expiresAt: expiresAt.toISOString(),
      });
    }

    // STOPPED OPERATOR - unchanged
    else if (operator.operator_type === "stopped") {
      const { data: pendingConv, error: pendingError } = await supabase
        .from("stopped_queue")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (pendingError) throw pendingError;

      if (!pendingConv) {
        return res.json({
          assigned: false,
          message: "No stopped conversations available",
        });
      }

      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 5);

      // Atomic assignment
      const { data: updated, error: updateError } = await supabase
        .from("stopped_queue")
        .update({
          status: "assigned",
          assigned_operator_id: operator_id,
          assigned_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .eq("id", pendingConv.id)
        .eq("status", "pending")
        .select()
        .single();

      if (!updated) {
        return res.json({
          assigned: false,
          message: "Conversation already assigned",
        });
      }

      if (updateError) throw updateError;

      const { data: conversation } = await supabase
        .from("conversations")
        .select(
          `
      *,
      user_profiles!conversations_user_id_fkey (*),
      fictional_profiles!conversations_fictional_profile_id_fkey (*)
    `,
        )
        .eq("id", pendingConv.conversation_id)
        .single();

      return res.json({
        assigned: true,
        type: "stopped",
        queueId: updated.id,
        conversationId: conversation.id,
        userProfile: conversation.user_profiles,
        fictionalProfile: conversation.fictional_profiles,
        expiresAt: expiresAt.toISOString(),
      });
    }
  } catch (err) {
    console.error("Assign next error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/operator/send-reply", async (req, res) => {
  try {
    const {
      queue_id,
      conversation_id,
      fictional_profile_id,
      content,
      operator_id,
      image_url,
      device_id,
    } = req.body;

    console.log("📨 Send reply request:", {
      queue_id,
      conversation_id,
      hasImage: !!image_url,
      contentLength: content?.length,
    });

    if (
      !queue_id ||
      !conversation_id ||
      !fictional_profile_id ||
      !operator_id
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Allow sending if there's an image OR text (not both required)
    if (!content && !image_url) {
      return res
        .status(400)
        .json({ error: "Either content or image is required" });
    }

    // If text is provided, check minimum length
    if (content && content.length < 20) {
      return res
        .status(400)
        .json({ error: "Message must be at least 20 characters" });
    }

    // ✅ STEP 1: Get conversation details
    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .select("active_operator_id, active_operator_device, active_operator_at")
      .eq("id", conversation_id)
      .single();

    if (conversationError) {
      console.error("❌ Ownership check error:", conversationError);
      return res.status(500).json({
        error: "Failed to validate conversation ownership",
      });
    }

    // ✅ STEP 2: Check if the operator actually has an active assignment
    const { data: activeQueue, error: queueCheckError } = await supabase
      .from("message_queue")
      .select("id, expires_at")
      .eq("conversation_id", conversation_id)
      .eq("assigned_operator_id", operator_id)
      .eq("status", "assigned")
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();

    // If no active queue assignment, release ownership and allow
    if (!activeQueue) {
      console.log("⚠️ No active queue assignment found, releasing ownership");
      await supabase
        .from("conversations")
        .update({
          active_operator_id: null,
          active_operator_device: null,
          active_operator_at: null,
        })
        .eq("id", conversation_id);

      // ✅ Continue to allow reply (don't return)
    }

    // ✅ STEP 3: Device validation - ONLY check if there's an active queue AND device is set
    if (
      activeQueue && // ✅ Only check if there's an active assignment
      conversation.active_operator_id === operator_id &&
      conversation.active_operator_device !== null && // ✅ Only check if device is set
      conversation.active_operator_device !== device_id
    ) {
      console.log("🚫 Duplicate device blocked:", {
        activeDevice: conversation.active_operator_device,
        currentDevice: device_id,
        operator: operator_id,
        queueId: activeQueue.id,
      });

      return res.status(409).json({
        error:
          "This conversation is already active on another device/tab for this operator account.",
        duplicate_device: true,
        active_device: conversation.active_operator_device,
      });
    }

    // ✅ If we got here, the operator can send the reply
    console.log("✅ Device validation passed, proceeding with reply");

    // ✅ Insert ONE message with both content and image_url
    const { data: message, error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation_id,
        sender_type: "fictional",
        sender_fictional_id: fictional_profile_id,
        content: content || null,
        image_url: image_url || null,
        direction: "fictional_to_user",
        credit_cost: 0,
        operator_id: operator_id,
      })
      .select()
      .single();

    if (insertError) {
      console.error("❌ Insert error:", insertError);
      return res.status(500).json({ error: insertError.message });
    }

    console.log("✅ Message inserted:", message.id);

    // If this was a photo from fictional_private_photos, log it
    if (image_url) {
      const { data: photo } = await supabase
        .from("fictional_private_photos")
        .select("id")
        .eq("image_url", image_url)
        .maybeSingle();

      if (photo) {
        await supabase.from("photo_sent_log").insert({
          photo_id: photo.id,
          conversation_id: conversation_id,
          sent_by_operator_id: operator_id,
          message_id: message.id,
          sent_at: new Date().toISOString(),
        });
      }
    }

    // Update conversation last message
    await supabase
      .from("conversations")
      .update({
        last_message_at: message.created_at,
        last_message_sender_id: fictional_profile_id,
        last_message_preview: content
          ? content.substring(0, 50)
          : "📷 Sent a photo",
      })
      .eq("id", conversation_id);

    // Mark user messages as read
    await supabase
      .from("messages")
      .update({ is_read: true })
      .eq("conversation_id", conversation_id)
      .eq("sender_type", "real_user");

    // ✅ Complete queue assignment after operator replies
    const { error: queueError } = await supabase
      .from("message_queue")
      .update({
        status: "completed",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
        conversation_assigned: false,
      })
      .eq("id", queue_id);

    if (queueError) {
      console.error("❌ Queue completion error:", queueError);
    }

    res.json({ success: true, message });
  } catch (err) {
    console.error("❌ Send reply error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Release a message back to the queue (when operator stops chatting or logs out)
// Release a message back to the queue (when operator stops chatting or logs out)
app.post("/operator/release-message", async (req, res) => {
  try {
    const { queue_id, operator_id } = req.body;

    if (!queue_id) {
      return res.status(400).json({ error: "Missing queue_id" });
    }

    console.log(`🔄 Releasing message ${queue_id} back to queue`);

    let released = false;
    let conversationId = null;

    // Try regular queue
    const { data: regularRows, error: regularError } = await supabase
      .from("message_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
        conversation_assigned: false,
      })
      .eq("id", queue_id)
      .eq("status", "assigned")
      .select();

    if (regularError) throw regularError;

    if (regularRows?.length) {
      released = true;
      conversationId = regularRows[0].conversation_id;
      console.log(`✅ Released regular queue item ${queue_id}`);
    }

    // Try stopped queue
    if (!released) {
      const { data: stoppedRows, error: stoppedError } = await supabase
        .from("stopped_queue")
        .update({
          status: "pending",
          assigned_operator_id: null,
          assigned_at: null,
          expires_at: null,
        })
        .eq("id", queue_id)
        .eq("status", "assigned")
        .select();

      if (stoppedError) throw stoppedError;

      if (stoppedRows?.length) {
        released = true;
        conversationId = stoppedRows[0].conversation_id;
        console.log(`✅ Released stopped queue item ${queue_id}`);
      }
    }

    // Try poke queue
    if (!released) {
      const { data: pokeRows, error: pokeError } = await supabase
        .from("poke_queue")
        .update({
          status: "pending",
          assigned_poker_id: null,
          assigned_at: null,
          expires_at: null,
        })
        .eq("id", queue_id)
        .eq("status", "assigned")
        .select();

      if (pokeError) throw pokeError;

      if (pokeRows?.length) {
        released = true;
        // Poke queue doesn't have conversation_id, but we can get it from the user
        console.log(`✅ Released poke queue item ${queue_id}`);
      }
    }

    // 🔥 CRITICAL FIX: Clear conversation ownership if we have a conversationId
    if (released && conversationId) {
      const { error: convError } = await supabase
        .from("conversations")
        .update({
          active_operator_id: null,
          active_operator_device: null,
          active_operator_at: null,
        })
        .eq("id", conversationId);

      if (convError) {
        console.error("❌ Failed to clear conversation ownership:", convError);
      } else {
        console.log(`✅ Cleared conversation ownership for ${conversationId}`);
      }
    }

    // Also clean up operator session if needed
    if (operator_id) {
      await supabase
        .from("operator_sessions")
        .update({
          last_heartbeat: new Date().toISOString(),
          current_message_id: null,
        })
        .eq("operator_id", operator_id);
    }

    if (!released) {
      console.log(`⚠️ Queue item ${queue_id} not found or already released`);
    }

    res.json({ success: true, message: "Message released back to queue" });
  } catch (err) {
    console.error("Release message error:", err);
    res.status(500).json({ error: err.message });
  }
});

// New endpoint: Force clear conversation lock (for recovery)
app.post("/operator/force-clear-lock", async (req, res) => {
  try {
    const { conversation_id, operator_id } = req.body;

    if (!conversation_id) {
      return res.status(400).json({ error: "Missing conversation_id" });
    }

    // Verify the operator has access to this conversation
    const { data: queueItem } = await supabase
      .from("message_queue")
      .select("id")
      .eq("conversation_id", conversation_id)
      .eq("assigned_operator_id", operator_id)
      .eq("status", "assigned")
      .maybeSingle();

    if (!queueItem) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Release the queue item
    await supabase
      .from("message_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
        conversation_assigned: false,
      })
      .eq("id", queueItem.id);

    // Clear conversation ownership
    await supabase
      .from("conversations")
      .update({
        active_operator_id: null,
        active_operator_device: null,
        active_operator_at: null,
      })
      .eq("id", conversation_id);

    res.json({ success: true, message: "Lock cleared successfully" });
  } catch (err) {
    console.error("Force clear lock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// LOGBOOK & PRIVATE PHOTOS ENDPOINTS
// ==========================

// Get private photos for a fictional profile
app.get("/operator/private-photos/:fictionalId", async (req, res) => {
  try {
    const { fictionalId } = req.params;
    const { conversation_id } = req.query;

    const { data: photos, error } = await supabase
      .from("fictional_private_photos")
      .select("*")
      .eq("fictional_profile_id", fictionalId)
      .order("display_order", { ascending: true });

    if (error) throw error;

    // Check which photos were already sent to this conversation
    const { data: sentPhotos, error: sentError } = await supabase
      .from("photo_sent_log")
      .select("photo_id")
      .eq("conversation_id", conversation_id);

    if (sentError) throw sentError;

    const sentPhotoIds = new Set(sentPhotos?.map((p) => p.photo_id) || []);

    const photosWithStatus = photos.map((photo) => ({
      ...photo,
      is_sent_to_conversation: sentPhotoIds.has(photo.id),
    }));

    res.json(photosWithStatus);
  } catch (err) {
    console.error("Private photos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Send a private photo
app.post("/operator/send-photo", async (req, res) => {
  try {
    const { photo_id, conversation_id, fictional_profile_id, operator_id } =
      req.body;

    if (
      !photo_id ||
      !conversation_id ||
      !fictional_profile_id ||
      !operator_id
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if photo was already sent to this conversation
    const { data: existing, error: checkError } = await supabase
      .from("photo_sent_log")
      .select("id")
      .eq("photo_id", photo_id)
      .eq("conversation_id", conversation_id)
      .maybeSingle();

    if (checkError) throw checkError;

    if (existing) {
      return res.status(400).json({
        error: "This photo has already been sent in this conversation",
      });
    }

    // Get the photo URL
    const { data: photo, error: photoError } = await supabase
      .from("fictional_private_photos")
      .select("image_url")
      .eq("id", photo_id)
      .single();

    if (photoError) throw photoError;

    // Insert message with image
    const { data: message, error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation_id,
        sender_type: "fictional",
        sender_fictional_id: fictional_profile_id,
        content: null,
        image_url: photo.image_url,
        direction: "fictional_to_user",
        credit_cost: 0,
        operator_id: operator_id,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // ✅ Log that the photo was sent with the message_id
    await supabase.from("photo_sent_log").insert({
      photo_id: photo_id,
      conversation_id: conversation_id,
      sent_by_operator_id: operator_id,
      message_id: message.id, // ✅ ADD THIS - links photo to the message
      sent_at: new Date().toISOString(),
    });

    // Update conversation last message
    await supabase
      .from("conversations")
      .update({
        last_message_at: message.created_at,
        last_message_sender_id: fictional_profile_id,
        last_message_preview: "[Image]",
      })
      .eq("id", conversation_id);

    res.json({ success: true, message });
  } catch (err) {
    console.error("Send photo error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get user logbook
app.get("/operator/user-logbook/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from("user_logbook")
      .select("*")
      .eq("user_profile_id", userId);

    if (error) throw error;

    const logbookMap = {};
    data?.forEach((item) => {
      logbookMap[item.category] = item.value;
    });

    res.json(logbookMap);
  } catch (err) {
    console.error("User logbook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Save user logbook entry
app.post("/operator/user-logbook", async (req, res) => {
  try {
    const { user_profile_id, category, value, operator_id } = req.body;

    if (!user_profile_id || !category || !operator_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("user_logbook")
      .upsert({
        user_profile_id,
        category,
        value: value || null,
        operator_id,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error("Save user logbook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get fictional logbook
app.get("/operator/fictional-logbook/:fictionalId", async (req, res) => {
  try {
    const { fictionalId } = req.params;
    const { data, error } = await supabase
      .from("fictional_logbook")
      .select("*")
      .eq("fictional_profile_id", fictionalId);

    if (error) throw error;

    const logbookMap = {};
    data?.forEach((item) => {
      logbookMap[item.category] = item.value;
    });

    res.json(logbookMap);
  } catch (err) {
    console.error("Fictional logbook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Save fictional logbook entry
app.post("/operator/fictional-logbook", async (req, res) => {
  try {
    const { fictional_profile_id, category, value, operator_id } = req.body;

    if (!fictional_profile_id || !category || !operator_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { data, error } = await supabase
      .from("fictional_logbook")
      .upsert({
        fictional_profile_id,
        category,
        value: value || null,
        operator_id,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error("Save fictional logbook error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/operator/heartbeat", async (req, res) => {
  try {
    const { operator_id } = req.body;

    if (!operator_id) {
      return res.status(400).json({
        error: "operator_id required",
      });
    }

    await supabase
      .from("operator_accounts")
      .update({
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", operator_id);

    res.json({
      success: true,
    });
  } catch (err) {
    console.error("Heartbeat error:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

// ***********************************************
// ==========================
// SMART FICTIONAL PROFILE SELECTOR FOR POKERS
// ==========================
// Smart fictional profile selector for pokers - matches by country, city, interests
async function selectBestFictionalProfile(user) {
  console.log("🎯 Selecting best fictional profile for user:", {
    country: user.user_country,
    city: user.user_city,
    interests: user.user_interests,
  });

  // Priority 1: User liked a specific fictional profile
  if (user.liked_fictional_ids && user.liked_fictional_ids.length > 0) {
    console.log(
      "📌 Priority 1: User liked specific profiles:",
      user.liked_fictional_ids,
    );

    const { data, error } = await supabase
      .from("fictional_profiles")
      .select("*")
      .in("id", user.liked_fictional_ids)
      .eq("is_deleted", false)
      .limit(1);

    if (data && data.length > 0) {
      console.log(
        "✅ Using liked profile:",
        data[0].display_name,
        "from",
        data[0].country,
      );
      return data[0];
    }
  }

  // Priority 2: Match by country AND city
  if (user.user_country && user.user_city) {
    console.log(
      "📍 Priority 2: Searching by country AND city:",
      user.user_country,
      user.user_city,
    );

    const { data, error } = await supabase
      .from("fictional_profiles")
      .select("*")
      .eq("country", user.user_country)
      .ilike("city", `%${user.user_city}%`)
      .eq("is_deleted", false)
      .limit(1);

    if (data && data.length > 0) {
      console.log("✅ Found by city match:", data[0].display_name);
      return data[0];
    }
  }

  // Priority 3: Match by country AND state
  if (user.user_country && user.user_state) {
    console.log(
      "📍 Priority 3: Searching by country AND state:",
      user.user_country,
      user.user_state,
    );

    const { data, error } = await supabase
      .from("fictional_profiles")
      .select("*")
      .eq("country", user.user_country)
      .ilike("state", `%${user.user_state}%`)
      .eq("is_deleted", false)
      .limit(1);

    if (data && data.length > 0) {
      console.log("✅ Found by state match:", data[0].display_name);
      return data[0];
    }
  }

  // Priority 4: Match by country AND interests (at least one shared interest)
  if (
    user.user_country &&
    user.user_interests &&
    user.user_interests.length > 0
  ) {
    console.log(
      "🎨 Priority 4: Searching by country AND interests:",
      user.user_country,
    );

    // Get fictional profiles from same country
    const { data, error } = await supabase
      .from("fictional_profiles")
      .select("*")
      .eq("country", user.user_country)
      .eq("is_deleted", false);

    if (data && data.length > 0) {
      // Find profiles that share at least one interest
      const userInterestsSet = new Set(
        user.user_interests.map((i) => i.toLowerCase().trim()),
      );

      const matchedProfiles = data.filter((profile) => {
        if (!profile.interests || profile.interests.length === 0) return false;
        const profileInterests = profile.interests.map((i) =>
          i.toLowerCase().trim(),
        );
        return profileInterests.some((interest) =>
          userInterestsSet.has(interest),
        );
      });

      if (matchedProfiles.length > 0) {
        console.log(
          "✅ Found by interest match:",
          matchedProfiles[0].display_name,
        );
        return matchedProfiles[0];
      }

      // If no interest match, return any profile from same country
      console.log(
        "✅ Using any profile from same country:",
        data[0].display_name,
      );
      return data[0];
    }
  }

  // Priority 5: Match by country only
  if (user.user_country) {
    console.log("🌍 Priority 5: Searching by country only:", user.user_country);

    const { data, error } = await supabase
      .from("fictional_profiles")
      .select("*")
      .eq("country", user.user_country)
      .eq("is_deleted", false)
      .limit(1);

    if (data && data.length > 0) {
      console.log("✅ Found by country match:", data[0].display_name);
      return data[0];
    }
  }

  // Priority 6: Fallback to any available fictional profile
  console.log("⚠️ No matching profile found, using fallback");
  const { data, error } = await supabase
    .from("fictional_profiles")
    .select("*")
    .eq("is_deleted", false)
    .limit(1);

  console.log("✅ Fallback profile:", data?.[0]?.display_name);
  return data?.[0] || null;
}

// ==========================
// POKER QUEUE ENDPOINTS
// ==========================

// Clean up expired assignments (older than 5 minutes)
const { data: expiredUsers, error: expiredError } = await supabase
  .from("poke_queue")
  .update({
    status: "pending",
    assigned_poker_id: null,
    assigned_at: null,
    expires_at: null,
  })
  .eq("status", "assigned")
  .lt("expires_at", new Date().toISOString())
  .select();

if (expiredUsers && expiredUsers.length > 0) {
  console.log(`🧹 Cleaned up ${expiredUsers.length} expired assignments`);
}

// Get next user for poker
app.get("/poker/next-user", async (req, res) => {
  try {
    const { operator_id } = req.query;

    if (!operator_id) {
      return res.status(400).json({ error: "Missing operator_id" });
    }

    // Check if operator is a poker
    const { data: operator, error: opError } = await supabase
      .from("operator_accounts")
      .select("operator_type")
      .eq("id", operator_id)
      .single();

    if (opError || !operator || operator.operator_type !== "poke") {
      return res.status(403).json({ error: "Not authorized as poker" });
    }

    // Check if poker has an assigned user
    const { data: assigned, error: assignedError } = await supabase
      .from("poke_queue")
      .select("*")
      .eq("assigned_poker_id", operator_id)
      .eq("status", "assigned")
      .gte("expires_at", new Date().toISOString())
      .maybeSingle();

    if (assignedError) throw assignedError;

    if (assigned) {
      // Get selected fictional profile
      const fictional = await selectBestFictionalProfile({
        liked_fictional_ids: assigned.liked_fictional_ids,
        user_interests: assigned.user_interests,
        user_country: assigned.user_country,
      });

      return res.json({
        hasUser: true,
        type: "assigned",
        queueId: assigned.id,
        user: {
          id: assigned.user_profile_id,
          display_name: assigned.user_display_name,
          age: assigned.user_age,
          country: assigned.user_country,
          city: assigned.user_city,
          interests: assigned.user_interests,
          liked_fictional_ids: assigned.liked_fictional_ids,
          liked_fictional_names: assigned.liked_fictional_names,
        },
        suggestedFictional: fictional,
        expiresAt: assigned.expires_at,
      });
    }

    // Get next pending user
    const { data: pending, error: pendingError } = await supabase
      .from("poke_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (pendingError) throw pendingError;

    if (!pending) {
      return res.json({ hasUser: false, message: "No new users available" });
    }

    // Select best fictional profile for this user
    const bestFictional = await selectBestFictionalProfile({
      liked_fictional_ids: pending.liked_fictional_ids,
      user_interests: pending.user_interests,
      user_country: pending.user_country,
    });

    if (!bestFictional) {
      return res.json({
        hasUser: false,
        message: "No fictional profiles available",
      });
    }

    // Assign user to this poker with 5-minute lock
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 5);

    const { data: updated, error: updateError } = await supabase
      .from("poke_queue")
      .update({
        status: "assigned",
        assigned_poker_id: operator_id,
        assigned_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq("id", pending.id)
      .eq("status", "pending")
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      hasUser: true,
      type: "new",
      queueId: updated.id,
      user: {
        id: updated.user_profile_id,
        display_name: updated.user_display_name,
        age: updated.user_age,
        country: updated.user_country,
        city: updated.user_city,
        interests: updated.user_interests,
        liked_fictional_ids: updated.liked_fictional_ids,
        liked_fictional_names: updated.liked_fictional_names,
      },
      suggestedFictional: bestFictional,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error("Poker next user error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Send flirt message from poker
app.post("/poker/send-flirt", async (req, res) => {
  try {
    const {
      queue_id,
      user_profile_id,
      fictional_profile_id,
      content,
      operator_id,
    } = req.body;

    if (
      !queue_id ||
      !user_profile_id ||
      !fictional_profile_id ||
      !content ||
      !operator_id
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if conversation already exists
    let conversationId;
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user_profile_id)
      .eq("fictional_profile_id", fictional_profile_id)
      .maybeSingle();

    if (existingConv) {
      conversationId = existingConv.id;
    } else {
      const { data: newConv, error: convError } = await supabase
        .from("conversations")
        .insert({
          user_id: user_profile_id,
          fictional_profile_id: fictional_profile_id,
          started_by_flirt: true,
        })
        .select()
        .single();

      if (convError) throw convError;
      conversationId = newConv.id;
    }

    // Insert flirt message
    const { data: message, error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        sender_type: "fictional",
        sender_fictional_id: fictional_profile_id,
        content: content,
        direction: "fictional_to_user",
        credit_cost: 0,
        operator_id: operator_id,
        is_flirt: true,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Update conversation
    await supabase
      .from("conversations")
      .update({
        last_message_at: message.created_at,
        last_message_sender_id: fictional_profile_id,
        last_message_preview: content.substring(0, 50),
      })
      .eq("id", conversationId);

    // Mark queue as completed
    await supabase
      .from("poke_queue")
      .update({ status: "completed" })
      .eq("id", queue_id);

    res.json({ success: true, message, conversationId });
  } catch (err) {
    console.error("Send flirt error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Release assigned user back to queue (when poker logs out or stops)
app.post("/poker/release-user", async (req, res) => {
  try {
    const { queue_id, operator_id } = req.body;

    if (!queue_id) {
      return res.status(400).json({ error: "Missing queue_id" });
    }

    console.log(
      `🔄 Releasing user ${queue_id} from poker ${operator_id} back to queue`,
    );

    // Update the poke_queue - set status back to pending
    const { data, error } = await supabase
      .from("poke_queue")
      .update({
        status: "pending",
        assigned_poker_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("id", queue_id)
      .eq("status", "assigned")
      .select();

    if (error) throw error;

    if (data && data.length > 0) {
      console.log(`✅ User ${queue_id} released successfully`);
    } else {
      console.log(`⚠️ User ${queue_id} was not in assigned state`);
    }

    res.json({ success: true, message: "User released back to queue" });
  } catch (err) {
    console.error("Release user error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// STOPPED OPERATOR ENDPOINTS
// ==========================

// In server/index.js - Add endpoint for stopped operators to send messages
app.post("/stopped/send-message", async (req, res) => {
  try {
    const {
      queue_id,
      conversation_id,
      fictional_profile_id,
      content,
      operator_id,
      image_url,
    } = req.body;

    if (
      !queue_id ||
      !conversation_id ||
      !fictional_profile_id ||
      !content ||
      !operator_id
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Insert the message
    const { data: message, error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation_id,
        sender_type: "fictional",
        sender_fictional_id: fictional_profile_id,
        content: content,
        image_url: image_url || null,
        direction: "fictional_to_user",
        credit_cost: 0,
        operator_id: operator_id,
        is_reengagement: true, // Mark as re-engagement message
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Update conversation last message
    await supabase
      .from("conversations")
      .update({
        last_message_at: message.created_at,
        last_message_sender_id: fictional_profile_id,
        last_message_preview: content.substring(0, 50),
      })
      .eq("id", conversation_id);

    // Mark queue item as completed
    const { error: completeError } = await supabase
      .from("stopped_queue")
      .update({
        status: "completed",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("id", queue_id);

    if (completeError) {
      throw completeError;
    }
    res.json({ success: true, message });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Release stopped conversation (if operator stops chatting)
app.post("/stopped/release", async (req, res) => {
  try {
    const { queue_id } = req.body;

    if (!queue_id) {
      return res.status(400).json({ error: "Missing queue_id" });
    }

    await supabase
      .from("stopped_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("id", queue_id);

    res.json({ success: true });
  } catch (err) {
    console.error("Release stopped error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// SIMPLIFIED MANAGER API ENDPOINTS
// ==========================
app.get("/manager/analytics", async (req, res) => {
  try {
    const { country = "all", days = 30 } = req.query;

    console.log("📊 Analytics request:", { country, days });

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // First, get all user IDs for the selected country (if country is not "all")
    let userIds = [];
    if (country && country !== "all") {
      const { data: users } = await supabase
        .from("user_profiles")
        .select("id")
        .eq("country", country);

      userIds = users?.map((u) => u.id) || [];

      if (userIds.length === 0) {
        return res.json({
          totals: {
            sent: 0,
            reported: 0,
            responseRatio: 0,
            userMessages: 0,
            responses: 0,
          },
          chart: { labels: [], sent: [], responses: [], reported: [] },
        });
      }
    }

    // Build query for messages
    let query = supabase
      .from("messages")
      .select(
        `
        id,
        created_at,
        sender_type,
        conversation_id
      `,
      )
      .gte("created_at", startDate.toISOString());

    // Apply country filter by conversation user_id
    if (country && country !== "all" && userIds.length > 0) {
      const { data: conversationIds } = await supabase
        .from("conversations")
        .select("id")
        .in("user_id", userIds);

      const convIds = conversationIds?.map((c) => c.id) || [];

      if (convIds.length > 0) {
        query = query.in("conversation_id", convIds);
      } else {
        return res.json({
          totals: {
            sent: 0,
            reported: 0,
            responseRatio: 0,
            userMessages: 0,
            responses: 0,
          },
          chart: { labels: [], sent: [], responses: [], reported: [] },
        });
      }
    }

    const { data: messages, error } = await query;

    if (error) {
      console.error("Analytics error:", error);
      return res.status(500).json({ error: error.message });
    }

    // Calculate totals
    const totalSent = messages?.length || 0;
    const userMessages =
      messages?.filter((m) => m.sender_type === "real_user")?.length || 0;
    const responses =
      messages?.filter((m) => m.sender_type === "fictional")?.length || 0;
    const responseRatio =
      userMessages > 0 ? ((responses / userMessages) * 100).toFixed(1) : 0;

    // Prepare chart data by date
    const chartData = {};
    messages?.forEach((msg) => {
      const date = msg.created_at.split("T")[0];
      if (!chartData[date]) {
        chartData[date] = { sent: 0, responses: 0 };
      }
      chartData[date].sent++;
      if (msg.sender_type === "fictional") {
        chartData[date].responses++;
      }
    });

    const labels = Object.keys(chartData).sort();
    const sentData = labels.map((d) => chartData[d].sent);
    const responseData = labels.map((d) => chartData[d].responses);

    console.log(`✅ Found ${totalSent} messages for country: ${country}`);

    res.json({
      totals: {
        sent: totalSent,
        reported: 0,
        responseRatio: parseFloat(responseRatio),
        userMessages,
        responses,
      },
      chart: {
        labels,
        sent: sentData,
        responses: responseData,
        reported: labels.map(() => 0),
      },
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/manager/conversations", async (req, res) => {
  try {
    const {
      country = "all",
      page = 1,
      limit = 20,
      startDate = "",
      endDate = "",
      search = "",
      operator_type = "all",
    } = req.query;

    console.log("📊 Conversations request:", {
      country,
      page,
      limit,
      startDate,
      endDate,
      search,
      operator_type,
    });

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    // Get conversations with date filters
    let query = supabase
      .from("conversations")
      .select(
        `
        id,
        created_at,
        user_id,
        fictional_profile_id
      `,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(from, to);

    // Apply date filters
    if (startDate) {
      const startDateTime = new Date(startDate);
      startDateTime.setHours(0, 0, 0, 0);
      query = query.gte("created_at", startDateTime.toISOString());
    }

    if (endDate) {
      const endDateTime = new Date(endDate);
      endDateTime.setHours(23, 59, 59, 999);
      query = query.lte("created_at", endDateTime.toISOString());
    }

    const { data: conversations, error, count } = await query;

    if (error) {
      console.error("Conversations error:", error);
      return res.status(500).json({ error: error.message });
    }

    if (!conversations || conversations.length === 0) {
      return res.json({
        conversations: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
      });
    }

    const conversationsWithDetails = [];

    for (const conv of conversations) {
      // Get FULL user profile
      const { data: user } = await supabase
        .from("user_profiles")
        .select("*")
        .eq("id", conv.user_id)
        .single();

      // Get FULL fictional profile
      const { data: fictional } = await supabase
        .from("fictional_profiles")
        .select("*")
        .eq("id", conv.fictional_profile_id)
        .single();

      // ✅ NEW: Get ALL messages for this conversation with operator details
      const { data: messages } = await supabase
        .from("messages")
        .select(
          `
          *,
          operator_accounts!operator_id (
            id,
            username,
            full_name,
            operator_type
          )
        `,
        )
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true });

      // Get latest message to find operator
      const { data: latestMessage } = await supabase
        .from("messages")
        .select("id, operator_id, created_at, content")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let operator = null;
      let operatorTypeValue = null;

      if (latestMessage?.operator_id) {
        const { data: opData } = await supabase
          .from("operator_accounts")
          .select("id, username, full_name, email, operator_type")
          .eq("id", latestMessage.operator_id)
          .single();
        operator = opData;
        operatorTypeValue = opData?.operator_type;
      }

      conversationsWithDetails.push({
        id: conv.id,
        created_at: conv.created_at,
        last_message_at: latestMessage?.created_at || conv.created_at,
        last_message_preview:
          latestMessage?.content?.substring(0, 50) || "No messages",
        user_profiles: user,
        fictional_profiles: fictional,
        operator: operator,
        operator_type: operatorTypeValue,
        messages: messages || [], // ✅ Now includes operator data for each message
      });
    }

    // Apply filters
    let filtered = conversationsWithDetails;

    if (operator_type && operator_type !== "all") {
      filtered = conversationsWithDetails.filter(
        (conv) => conv.operator_type === operator_type,
      );
    }

    if (country && country !== "all") {
      filtered = filtered.filter(
        (conv) =>
          conv.user_profiles?.country === country ||
          conv.fictional_profiles?.country === country,
      );
    }

    if (search && search.trim() !== "") {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (conv) =>
          conv.user_profiles?.display_name
            ?.toLowerCase()
            .includes(searchLower) ||
          conv.user_profiles?.email?.toLowerCase().includes(searchLower) ||
          conv.fictional_profiles?.display_name
            ?.toLowerCase()
            .includes(searchLower),
      );
    }

    console.log(`✅ Found ${filtered.length} conversations`);

    res.json({
      conversations: filtered,
      total: filtered.length,
      page: parseInt(page),
      totalPages: Math.ceil(filtered.length / parseInt(limit)),
    });
  } catch (err) {
    console.error("Conversations API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get operators list with search and operator_type filter
app.get("/manager/operators", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = "",
      operator_type = "all",
    } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    let query = supabase
      .from("operator_accounts")
      .select("*", { count: "exact" });

    // Apply search filter
    if (search && search.trim() !== "") {
      query = query.or(
        `username.ilike.%${search}%,email.ilike.%${search}%,full_name.ilike.%${search}%`,
      );
    }

    // ✅ Apply operator_type filter
    if (operator_type && operator_type !== "all") {
      query = query.eq("operator_type", operator_type);
    }

    const {
      data: operators,
      error,
      count,
    } = await query.order("created_at", { ascending: false }).range(from, to);

    if (error) throw error;

    res.json({
      operators: operators || [],
      total: count || 0,
      page: parseInt(page),
      totalPages: Math.ceil((count || 0) / parseInt(limit)),
    });
  } catch (err) {
    console.error("Operators error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a new operator (from Manager App)
app.post("/manager/operators", async (req, res) => {
  try {
    const { username, email, full_name, password, operator_type, role } =
      req.body;

    console.log("➕ Creating operator:", {
      username,
      email,
      operator_type,
      role,
    });

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // ✅ Use the operator_type from the request body, not the default
    const { data: operator, error } = await supabase
      .from("operator_accounts")
      .insert({
        username,
        email,
        full_name: full_name || username,
        password_hash: hashedPassword,
        operator_type: operator_type || "regular", // ✅ Use the value from frontend
        role: role || "operator",
        is_active: true,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error("Operator insert error:", error);
      return res.status(500).json({ error: error.message });
    }

    const { password_hash, ...safeOperator } = operator;
    res.json({ success: true, operator: safeOperator });
  } catch (err) {
    console.error("Create operator error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get blocked profiles (simplified)
// Get blocked profiles (fixed - same pattern as conversations)
app.get("/manager/blocked-profiles", async (req, res) => {
  try {
    const { country = "all", page = 1, limit = 20 } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    console.log("🚫 Fetching blocked profiles...");

    // First, get all blocked profiles with pagination
    const {
      data: blocks,
      error,
      count,
    } = await supabase
      .from("blocked_profiles")
      .select("*", { count: "exact" })
      .order("blocked_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Blocked profiles query error:", error);
      return res.status(500).json({ error: error.message });
    }

    if (!blocks || blocks.length === 0) {
      return res.json({
        blocks: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
      });
    }

    // Get user details for each block (separate queries to avoid join issues)
    const blocksWithDetails = [];

    for (const block of blocks) {
      // Get user profile
      const { data: user } = await supabase
        .from("user_profiles")
        .select("*")
        .eq("id", block.user_profile_id)
        .maybeSingle();

      // Get fictional profile
      const { data: fictional } = await supabase
        .from("fictional_profiles")
        .select("id, display_name, country")
        .eq("id", block.blocked_fictional_id)
        .maybeSingle();

      blocksWithDetails.push({
        id: block.id,
        blocked_at: block.blocked_at,
        user_profiles: user || {
          display_name: "Unknown User",
          email: "No email",
        },
        fictional_profiles: fictional || {
          display_name: "Unknown Profile",
          country: "N/A",
        },
      });
    }

    // Apply country filter
    let filteredBlocks = blocksWithDetails;
    if (country && country !== "all") {
      filteredBlocks = blocksWithDetails.filter(
        (block) => block.fictional_profiles?.country === country,
      );
    }

    console.log(`✅ Found ${filteredBlocks.length} blocked profiles`);

    res.json({
      blocks: filteredBlocks,
      total: filteredBlocks.length,
      page: parseInt(page),
      totalPages: Math.ceil(filteredBlocks.length / parseInt(limit)),
    });
  } catch (err) {
    console.error("Blocked profiles error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/manager/reports", async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 20 } = req.query;

    console.log("📋 Reports request:", { status, page, limit });

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    // First, get reports
    let query = supabase
      .from("reports")
      .select("*")
      .order("reported_at", { ascending: false })
      .range(from, to);

    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    const { data: reports, error, count } = await query;

    if (error) {
      console.error("Reports query error:", error);
      return res.json({
        reports: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
      });
    }

    if (!reports || reports.length === 0) {
      return res.json({
        reports: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
      });
    }

    console.log("Raw reports data:", JSON.stringify(reports, null, 2));

    // Get unique IDs
    const reporterIds = [
      ...new Set(reports.map((r) => r.reporter_profile_id).filter(Boolean)),
    ];
    const fictionalIds = [
      ...new Set(reports.map((r) => r.reported_fictional_id).filter(Boolean)),
    ];

    console.log("Looking for users with IDs:", reporterIds);
    console.log("Looking for fictionals with IDs:", fictionalIds);

    // Fetch users - try both id and user_id
    let reporterMap = new Map();
    if (reporterIds.length > 0) {
      // First try by id
      const { data: usersById } = await supabase
        .from("user_profiles")
        .select("*")
        .in("id", reporterIds);

      console.log("Users found by id:", usersById);

      usersById?.forEach((u) => reporterMap.set(u.id, u));

      // If not found, try by user_id (auth user id)
      const remainingIds = reporterIds.filter((id) => !reporterMap.has(id));
      if (remainingIds.length > 0) {
        const { data: usersByUserId } = await supabase
          .from("user_profiles")
          .select("*")
          .in("user_id", remainingIds);

        console.log("Users found by user_id:", usersByUserId);
        usersByUserId?.forEach((u) => reporterMap.set(u.user_id, u));
      }
    }

    // Fetch fictional profiles
    let fictionalMap = new Map();
    if (fictionalIds.length > 0) {
      const { data: fictionals } = await supabase
        .from("fictional_profiles")
        .select("*")
        .in("id", fictionalIds);

      console.log("Fictionals found:", fictionals);
      fictionalMap = new Map(fictionals?.map((f) => [f.id, f]) || []);
    }

    // Build response
    const reportsWithNames = reports.map((report) => {
      const reporter = reporterMap.get(report.reporter_profile_id);
      console.log(
        `Report ${report.id}: reporter_id=${report.reporter_profile_id}, found=${!!reporter}`,
      );

      return {
        id: report.id,
        reason: report.reason,
        status: report.status,
        reported_at: report.reported_at,
        reporter_profile: reporter || {
          display_name: "Unknown User",
          email: "Unknown",
          country: "Unknown",
        },
        reported_fictional: fictionalMap.get(report.reported_fictional_id) || {
          display_name: "Unknown Profile",
          country: "Unknown",
        },
      };
    });

    console.log(`✅ Found ${reportsWithNames.length} reports`);

    res.json({
      reports: reportsWithNames,
      total: count || 0,
      page: parseInt(page),
      totalPages: Math.ceil((count || 0) / parseInt(limit)),
    });
  } catch (err) {
    console.error("Reports error:", err);
    res.status(500).json({
      reports: [],
      total: 0,
      page: 1,
      totalPages: 0,
      error: err.message,
    });
  }
});

// Update report status
app.put("/manager/reports/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    console.log("📝 Update report:", { id, status });

    // Only update status (remove reviewed_at if column doesn't exist)
    const { error } = await supabase
      .from("reports")
      .update({
        status: status,
      })
      .eq("id", id);

    if (error) {
      console.error("Update report error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Update report error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create operator
app.get("/manager/operators", requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    const {
      data: operators,
      error,
      count,
    } = await supabase
      .from("operator_accounts")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw error;

    // Don't send password_hash to frontend
    const safeOperators = operators?.map(({ password_hash, ...rest }) => rest);

    res.json({
      operators: safeOperators || [],
      total: count || 0,
      page: parseInt(page),
      totalPages: Math.ceil((count || 0) / parseInt(limit)),
    });
  } catch (err) {
    console.error("Operators error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update operator
app.put("/manager/operators/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, full_name, email, role, password } = req.body;

    const updateData = { username, full_name, email, role };

    if (password) {
      const saltRounds = 10;
      updateData.password_hash = await bcrypt.hash(password, saltRounds);
    }

    const { data, error } = await supabase
      .from("operator_accounts")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    const { password_hash, ...safeOperator } = data;
    res.json({ success: true, operator: safeOperator });
  } catch (err) {
    console.error("Update operator error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete operator
app.delete("/manager/operators/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("operator_accounts")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Delete operator error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle block operator
app.post(
  "/manager/operators/:id/toggle-block",
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { is_blocked } = req.body;

      const { error } = await supabase
        .from("operator_accounts")
        .update({
          is_blocked,
          blocked_at: is_blocked ? new Date().toISOString() : null,
        })
        .eq("id", id);

      if (error) throw error;

      res.json({ success: true });
    } catch (err) {
      console.error("Toggle block error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);
// Get operator statistics with date filtering
app.get("/manager/operator-stats", async (req, res) => {
  try {
    const { operator_id, startDate, endDate } = req.query;

    let query = supabase
      .from("messages")
      .select(
        `
        id,
        content,
        created_at,
        operator_id,
        conversation_id,
        conversations!inner (
          user_profiles!conversations_user_id_fkey (
            id,
            display_name
          ),
          fictional_profiles!conversations_fictional_profile_id_fkey (
            id,
            display_name
          )
        )
      `,
      )
      .eq("sender_type", "fictional")
      .not("operator_id", "is", null)
      .eq("operator_id", operator_id);

    if (startDate) {
      query = query.gte("created_at", startDate);
    }
    if (endDate) {
      const endDateTime = new Date(endDate);
      endDateTime.setHours(23, 59, 59, 999);
      query = query.lte("created_at", endDateTime.toISOString());
    }

    query = query.order("created_at", { ascending: false });

    const { data: messages, error } = await query;

    if (error) throw error;

    // Calculate stats
    const now = new Date();
    const todayReset = new Date(now);

    if (now.getHours() < 1) {
      todayReset.setDate(todayReset.getDate() - 1);
    }

    todayReset.setHours(1, 0, 0, 0);
    const weekAgo = new Date(now.setDate(now.getDate() - 7)).toISOString();
    const monthAgo = new Date(now.setMonth(now.getMonth() - 1)).toISOString();

    const daily =
      messages?.filter((m) => new Date(m.created_at) >= todayReset).length || 0;
    const weekly = messages?.filter((m) => m.created_at >= weekAgo).length || 0;
    const monthly =
      messages?.filter((m) => m.created_at >= monthAgo).length || 0;
    const allTime = messages?.length || 0;

    // Format messages for display
    const formattedMessages =
      messages?.map((msg) => ({
        id: msg.id,
        content: msg.content,
        created_at: msg.created_at,
        user: msg.conversations?.user_profiles,
        fictional: msg.conversations?.fictional_profiles,
      })) || [];

    res.json({
      stats: { daily, weekly, monthly, allTime },
      messages: formattedMessages,
    });
  } catch (err) {
    console.error("Operator stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Manager login
app.post("/manager/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("🔐 Manager login:", email);

    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError) {
      console.log("Auth error:", authError.message);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const { data: manager, error: managerError } = await supabase
      .from("managers")
      .select("*")
      .eq("user_id", authData.user.id)
      .single();

    if (managerError || !manager) {
      console.log("Not a manager");
      await supabase.auth.signOut();
      return res.status(401).json({ error: "Not authorized as manager" });
    }

    if (!manager.is_active) {
      await supabase.auth.signOut();
      return res.status(401).json({ error: "Account disabled" });
    }

    res.json({
      id: manager.id,
      username: manager.username,
      full_name: manager.full_name,
      email: manager.email,
      role: manager.role,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get managers list with search
app.get("/manager/managers", async (req, res) => {
  try {
    const { page = 1, limit = 20, search = "" } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    // ✅ Define query first
    let query = supabase.from("managers").select("*", { count: "exact" });

    // ✅ Apply search filter if search term exists
    if (search && search.trim() !== "") {
      query = query.or(
        `username.ilike.%${search}%,email.ilike.%${search}%,full_name.ilike.%${search}%`,
      );
    }

    const {
      data: managers,
      error,
      count,
    } = await query.order("created_at", { ascending: false }).range(from, to);

    if (error) throw error;

    res.json({
      managers: managers || [],
      total: count || 0,
      page: parseInt(page),
      totalPages: Math.ceil((count || 0) / parseInt(limit)),
    });
  } catch (err) {
    console.error("Managers error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a new manager (using Supabase Auth)
app.post("/manager/managers", async (req, res) => {
  try {
    const { username, email, full_name, password, role } = req.body;

    console.log("➕ Creating manager:", { username, email, role });

    // Validate required fields
    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ error: "Username, email, and password are required" });
    }

    // Check if username already exists in managers table
    const { data: existing, error: checkError } = await supabase
      .from("managers")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: "Username already exists" });
    }

    // Step 1: Create user in Supabase Auth
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: full_name || username,
          username,
        },
      });

    if (authError) {
      console.error("Auth creation error:", authError);
      return res.status(500).json({ error: authError.message });
    }

    // Step 2: Create manager record (NO password_hash column)
    const { data: manager, error } = await supabase
      .from("managers")
      .insert({
        user_id: authData.user.id, // Link to auth user
        username,
        email,
        full_name: full_name || username,
        role: role || "manager",
        is_active: true,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error("Manager insert error:", error);
      // Rollback - delete the auth user if manager creation fails
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, manager });
  } catch (err) {
    console.error("Create manager error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Update manager
app.put("/manager/managers/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { username, full_name, email, role, password } = req.body;

    const updateData = { username, full_name, email, role };

    if (password) {
      const saltRounds = 10;
      updateData.password_hash = await bcrypt.hash(password, saltRounds);
    }

    const { data, error } = await supabase
      .from("managers")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    const { password_hash, ...safeManager } = data;
    res.json({ success: true, manager: safeManager });
  } catch (err) {
    console.error("Update manager error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle manager active status
app.post("/manager/managers/:id/toggle-active", async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    console.log("🔒 Toggle manager active:", { id, is_active });

    const { error } = await supabase
      .from("managers")
      .update({ is_active })
      .eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Toggle active error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle operator active status
app.post("/manager/operators/:id/toggle-active", async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    console.log("🔒 Toggle operator active:", { id, is_active });

    const { error } = await supabase
      .from("operator_accounts")
      .update({ is_active })
      .eq("id", id);

    if (error) {
      console.error("Update error:", error);
      return res.status(500).json({ error: error.message });
    }

    console.log("✅ Operator updated successfully");
    res.json({ success: true });
  } catch (err) {
    console.error("Toggle active error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete manager
app.delete("/manager/managers/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from("managers").delete().eq("id", id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Delete manager error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/manager/messages", async (req, res) => {
  try {
    const {
      country = "all",
      page = 1,
      limit = 20,
      startDate = "",
      endDate = "",
      search = "",
      operator_type = "all",
      message_type = "all",
    } = req.query;

    console.log("📊 Message Analytics request:", {
      country,
      page,
      limit,
      startDate,
      endDate,
      search,
      operator_type,
      message_type,
    });

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    // STEP 1: Get ALL messages with date filters (no pagination yet)
    let query = supabase
      .from("messages")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });

    // Apply date filters
    if (startDate) {
      const startDateTime = new Date(startDate);
      startDateTime.setHours(0, 0, 0, 0);
      query = query.gte("created_at", startDateTime.toISOString());
    }

    if (endDate) {
      const endDateTime = new Date(endDate);
      endDateTime.setHours(23, 59, 59, 999);
      query = query.lte("created_at", endDateTime.toISOString());
    }

    // Apply message type filter at DB level
    if (message_type && message_type !== "all") {
      query = query.eq(
        "sender_type",
        message_type === "user" ? "real_user" : "fictional",
      );
    }

    const { data: allMessages, error, count } = await query;

    if (error) {
      console.error("Messages error:", error);
      return res.status(500).json({ error: error.message });
    }

    if (!allMessages || allMessages.length === 0) {
      return res.json({
        messages: [],
        total: 0,
        page: parseInt(page),
        totalPages: 0,
        stats: {
          totalMessages: 0,
          userMessages: 0,
          operatorReplies: 0,
          processedToday: 0,
        },
      });
    }

    // STEP 2: Get unique conversation IDs
    const conversationIds = [
      ...new Set(allMessages.map((m) => m.conversation_id).filter(Boolean)),
    ];

    // STEP 3: Get conversations with user and fictional data
    let userMap = new Map();
    let fictionalMap = new Map();
    let conversationUserMap = new Map(); // map conversation_id -> { user_id, fictional_id }

    if (conversationIds.length > 0) {
      const { data: conversations } = await supabase
        .from("conversations")
        .select("id, user_id, fictional_profile_id")
        .in("id", conversationIds);

      if (conversations) {
        // Store conversation mapping
        conversations.forEach((conv) => {
          conversationUserMap.set(conv.id, {
            user_id: conv.user_id,
            fictional_id: conv.fictional_profile_id,
          });
        });

        const userIds = [
          ...new Set(conversations.map((c) => c.user_id).filter(Boolean)),
        ];
        const fictionalIds = [
          ...new Set(
            conversations.map((c) => c.fictional_profile_id).filter(Boolean),
          ),
        ];

        if (userIds.length > 0) {
          const { data: users } = await supabase
            .from("user_profiles")
            .select("*")
            .in("id", userIds);
          userMap = new Map(users?.map((u) => [u.id, u]) || []);
        }

        if (fictionalIds.length > 0) {
          const { data: fictionals } = await supabase
            .from("fictional_profiles")
            .select("*")
            .in("id", fictionalIds);
          fictionalMap = new Map(fictionals?.map((f) => [f.id, f]) || []);
        }
      }
    }

    // STEP 4: Get operator details
    const operatorIds = [
      ...new Set(
        allMessages.filter((m) => m.operator_id).map((m) => m.operator_id),
      ),
    ];
    let operatorMap = new Map();

    if (operatorIds.length > 0) {
      const { data: operators } = await supabase
        .from("operator_accounts")
        .select("id, username, full_name, email, operator_type")
        .in("id", operatorIds);
      operatorMap = new Map(operators?.map((o) => [o.id, o]) || []);
    }

    // STEP 5: Get operator_type for all operators (for filtering)
    const { data: allOperators } = await supabase
      .from("operator_accounts")
      .select("id, operator_type");
    const operatorTypeMap = new Map(
      allOperators?.map((o) => [o.id, o.operator_type]) || [],
    );

    // STEP 6: Get the operator who replied to each conversation (the latest fictional message)
    let conversationOperatorMap = new Map(); // conversation_id -> operator_id

    if (conversationIds.length > 0) {
      const { data: conversationReplies } = await supabase
        .from("messages")
        .select("conversation_id, operator_id")
        .in("conversation_id", conversationIds)
        .eq("sender_type", "fictional")
        .eq("credit_cost", 0)
        .order("created_at", { ascending: false });

      // For each conversation, get the operator who replied (first one found)
      conversationReplies?.forEach((reply) => {
        if (
          !conversationOperatorMap.has(reply.conversation_id) &&
          reply.operator_id
        ) {
          conversationOperatorMap.set(reply.conversation_id, reply.operator_id);
        }
      });
    }

    // STEP 7: Calculate today's processed count for each operator
    const todayReset = new Date();
    todayReset.setHours(1, 0, 0, 0);
    const resetTimeUTC = todayReset.toISOString();

    const { data: todayCounts } = await supabase
      .from("messages")
      .select("operator_id")
      .eq("sender_type", "fictional")
      .eq("credit_cost", 0)
      .gte("created_at", resetTimeUTC);

    const operatorTodayCount = {};
    todayCounts?.forEach((msg) => {
      if (msg.operator_id) {
        operatorTodayCount[msg.operator_id] =
          (operatorTodayCount[msg.operator_id] || 0) + 1;
      }
    });

    // STEP 8: Build ALL messages with user/fictional data
    let allFormattedMessages = [];

    for (const msg of allMessages) {
      const convInfo = conversationUserMap.get(msg.conversation_id);

      let user = null;
      let fictional = null;

      if (convInfo) {
        user = userMap.get(convInfo.user_id);
        fictional = fictionalMap.get(convInfo.fictional_id);
      }

      // Determine which operator to show
      let displayOperator = null;
      let isDirectOperator = false;

      if (msg.operator_id) {
        // This message has an operator directly (operator reply)
        displayOperator = operatorMap.get(msg.operator_id);
        isDirectOperator = true;
      } else if (msg.sender_type === "real_user") {
        // For user messages, show the operator who handled this conversation
        const conversationOperatorId = conversationOperatorMap.get(
          msg.conversation_id,
        );
        if (conversationOperatorId) {
          displayOperator = operatorMap.get(conversationOperatorId);
          isDirectOperator = false;
        }
      }

      const processedToday = displayOperator
        ? operatorTodayCount[displayOperator.id] || 0
        : 0;
      const msgOperatorType = displayOperator
        ? displayOperator.operator_type
        : msg.operator_id
          ? operatorTypeMap.get(msg.operator_id)
          : null;

      allFormattedMessages.push({
        id: msg.id,
        content: msg.content,
        created_at: msg.created_at,
        sender_type: msg.sender_type,
        operator_id: msg.operator_id,
        conversation_id: msg.conversation_id,
        user: user,
        fictional: fictional,
        operator: displayOperator,
        is_direct_operator: isDirectOperator,
        processed_today: processedToday,
        operator_type: msgOperatorType,
      });
    }

    // STEP 9: Apply filters (operator_type, country, search)
    let filteredMessages = [...allFormattedMessages];

    // Apply operator type filter
    if (operator_type && operator_type !== "all") {
      filteredMessages = filteredMessages.filter(
        (msg) => msg.operator_type === operator_type,
      );
    }

    // Apply country filter
    if (country && country !== "all") {
      filteredMessages = filteredMessages.filter(
        (msg) =>
          msg.user?.country === country || msg.fictional?.country === country,
      );
    }

    // Apply search filter
    if (search && search.trim() !== "") {
      const searchLower = search.toLowerCase();
      filteredMessages = filteredMessages.filter(
        (msg) =>
          msg.user?.display_name?.toLowerCase().includes(searchLower) ||
          msg.user?.email?.toLowerCase().includes(searchLower) ||
          msg.fictional?.display_name?.toLowerCase().includes(searchLower) ||
          msg.content?.toLowerCase().includes(searchLower),
      );
    }

    // STEP 10: Calculate stats (before pagination)
    const today = new Date().toISOString().split("T")[0];
    const stats = {
      totalMessages: filteredMessages.length,
      userMessages: filteredMessages.filter(
        (m) => m.sender_type === "real_user",
      ).length,
      operatorReplies: filteredMessages.filter(
        (m) => m.sender_type === "fictional",
      ).length,
      processedToday: filteredMessages.filter(
        (m) =>
          m.created_at?.split("T")[0] === today &&
          m.sender_type === "fictional",
      ).length,
    };

    // STEP 11: Apply pagination
    const paginatedMessages = filteredMessages.slice(from, to + 1);

    console.log(
      `✅ Total: ${filteredMessages.length}, Showing page ${page}: ${paginatedMessages.length} messages`,
    );

    res.json({
      messages: paginatedMessages,
      total: filteredMessages.length,
      page: parseInt(page),
      totalPages: Math.ceil(filteredMessages.length / parseInt(limit)),
      stats,
    });
  } catch (err) {
    console.error("Message Analytics error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// QUEUE DASHBOARD STATS
// ==========================

// Get queue statistics for the manager dashboard
app.get("/manager/queue-stats", async (req, res) => {
  try {
    const now = new Date().toISOString();
    const staleThreshold = new Date();
    staleThreshold.setMinutes(staleThreshold.getMinutes() - 2);

    // 1. Get pending messages count (unique conversations waiting)
    const { count: pendingConversations, error: pendingError } = await supabase
      .from("message_queue")
      .select("conversation_id", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("conversation_assigned", false);

    if (pendingError) throw pendingError;

    // 2. Get assigned messages count
    const { count: assignedMessages, error: assignedError } = await supabase
      .from("message_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "assigned")
      .gte("expires_at", now);

    if (assignedError) throw assignedError;

    // 3. Get active operators count (heartbeat within last 2 minutes)
    const { count: activeOperators, error: activeError } = await supabase
      .from("operator_sessions")
      .select("operator_id", { count: "exact", head: true })
      .eq("status", "online")
      .gte("last_heartbeat", staleThreshold.toISOString());

    if (activeError) throw activeError;

    // 4. Get pending messages by country
    const { data: pendingByCountry, error: countryError } = await supabase
      .from("message_queue")
      .select(
        `
        conversation_id,
        conversations!inner (
          user_profiles!conversations_user_id_fkey (
            country
          )
        )
      `,
      )
      .eq("status", "pending")
      .eq("conversation_assigned", false);

    if (countryError) throw countryError;

    // Count pending messages by country
    const countryCounts = {};
    pendingByCountry?.forEach((item) => {
      const country = item.conversations?.user_profiles?.country || "Unknown";
      countryCounts[country] = (countryCounts[country] || 0) + 1;
    });

    // Format country data for display
    const countries = Object.keys(countryCounts).map((code) => ({
      code: code,
      count: countryCounts[code],
    }));

    // 5. Get total operators (for reference)
    const { count: totalOperators, error: totalError } = await supabase
      .from("operator_accounts")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (totalError) throw totalError;

    // 6. Get recent queue items (last 5 for activity feed)
    const { data: recentActivity, error: recentError } = await supabase
      .from("message_queue")
      .select(
        `
        id,
        status,
        created_at,
        assigned_operator_id,
        conversations!inner (
          user_profiles!conversations_user_id_fkey (
            display_name,
            country
          )
        )
      `,
      )
      .order("created_at", { ascending: false })
      .limit(5);

    if (recentError) throw recentError;

    // Format recent activity
    const activity =
      recentActivity?.map((item) => ({
        id: item.id,
        status: item.status,
        created_at: item.created_at,
        user_name: item.conversations?.user_profiles?.display_name || "Unknown",
        country: item.conversations?.user_profiles?.country || "Unknown",
        assigned_operator_id: item.assigned_operator_id,
      })) || [];

    res.json({
      success: true,
      stats: {
        pendingConversations: pendingConversations || 0,
        assignedMessages: assignedMessages || 0,
        activeOperators: activeOperators || 0,
        totalOperators: totalOperators || 0,
        countries: countries,
        recentActivity: activity,
        threshold: 15, // Alert threshold
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("❌ Queue stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// STRIPE ROUTES
// ==========================
app.use("/payments", paymentsRouter);

// ==========================
// START SERVER (LAST)
// ==========================
const PORT = process.env.PORT || 4000;

// ==========================
// GLOBAL CLEANUP - Run every minute
// ==========================
const cleanupExpiredAssignments = async () => {
  try {
    // Clean up expired message_queue assignments
    const { data: expiredMessages, error: msgError } = await supabase
      .from("message_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
        conversation_assigned: false,
      })
      .eq("status", "assigned")
      .lt("expires_at", new Date().toISOString())
      .select();

    if (expiredMessages?.length > 0) {
      console.log(
        `🧹 Cleaned up ${expiredMessages.length} expired message assignments`,
      );

      // 🔥 CRITICAL FIX: Clear conversation ownership for expired messages
      const conversationIds = expiredMessages
        .map((m) => m.conversation_id)
        .filter(Boolean);

      if (conversationIds.length > 0) {
        const { error: convError } = await supabase
          .from("conversations")
          .update({
            active_operator_id: null,
            active_operator_device: null,
            active_operator_at: null,
          })
          .in("id", conversationIds);

        if (convError) {
          console.error(
            "❌ Failed to clear conversation ownership for expired messages:",
            convError,
          );
        } else {
          console.log(
            `✅ Cleared ownership for ${conversationIds.length} expired conversations`,
          );
        }
      }
    }

    // Clean up expired poke_queue assignments
    const { data: expiredPokes, error: pokeError } = await supabase
      .from("poke_queue")
      .update({
        status: "pending",
        assigned_poker_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("status", "assigned")
      .lt("expires_at", new Date().toISOString())
      .select();

    if (expiredPokes?.length > 0) {
      console.log(
        `🧹 Cleaned up ${expiredPokes.length} expired poke assignments`,
      );
    }

    // Clean up expired stopped_queue assignments
    const { data: expiredStopped, error: stoppedError } = await supabase
      .from("stopped_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
      })
      .eq("status", "assigned")
      .lt("expires_at", new Date().toISOString())
      .select();

    if (expiredStopped?.length > 0) {
      console.log(
        `🧹 Cleaned up ${expiredStopped.length} expired stopped assignments`,
      );

      // Clear conversation ownership for stopped conversations too
      const conversationIds = expiredStopped
        .map((m) => m.conversation_id)
        .filter(Boolean);

      if (conversationIds.length > 0) {
        await supabase
          .from("conversations")
          .update({
            active_operator_id: null,
            active_operator_device: null,
            active_operator_at: null,
          })
          .in("id", conversationIds);
      }
    }

    // Clean up orphaned records (assigned but no operator_id)
    const { data: orphanedMessages, error: orphanError } = await supabase
      .from("message_queue")
      .update({
        status: "pending",
        assigned_operator_id: null,
        assigned_at: null,
        expires_at: null,
        conversation_assigned: false,
      })
      .eq("status", "assigned")
      .is("assigned_operator_id", null)
      .select();

    if (orphanedMessages?.length > 0) {
      console.log(
        `🧹 Cleaned up ${orphanedMessages.length} orphaned message assignments`,
      );

      // Also clear conversation ownership for orphaned messages
      const convIds = orphanedMessages
        .map((m) => m.conversation_id)
        .filter(Boolean);
      if (convIds.length > 0) {
        await supabase
          .from("conversations")
          .update({
            active_operator_id: null,
            active_operator_device: null,
            active_operator_at: null,
          })
          .in("id", convIds);
      }
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
};

// Run cleanup every minute
setInterval(cleanupExpiredAssignments, 60 * 1000);

// ==========================
// HEARTBEAT MONITORING
// ==========================

// Endpoint for operators to send heartbeat
app.post("/operator/heartbeat", async (req, res) => {
  try {
    const { operator_id, device_id, queue_id } = req.body;

    if (!operator_id) {
      return res.status(400).json({
        error: "operator_id required",
      });
    }

    // Update operator's last seen
    await supabase
      .from("operator_accounts")
      .update({
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", operator_id);

    // Update or create operator session
    await supabase.from("operator_sessions").upsert(
      {
        operator_id: operator_id,
        device_id: device_id || null,
        status: "online",
        current_queue_id: queue_id || null,
        last_heartbeat: new Date().toISOString(),
      },
      {
        onConflict: "operator_id",
      },
    );

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Heartbeat error:", err);
    res.status(500).json({
      error: err.message,
    });
  }
});

// Heartbeat cleanup - runs every 2 minutes to check for stale operators
const cleanupStaleOperators = async () => {
  try {
    const staleThreshold = new Date();
    staleThreshold.setMinutes(staleThreshold.getMinutes() - 2); // 2 minutes without heartbeat

    // Find stale sessions
    const { data: staleSessions, error: sessionError } = await supabase
      .from("operator_sessions")
      .select("operator_id, current_queue_id")
      .lt("last_heartbeat", staleThreshold.toISOString())
      .eq("status", "online");

    if (sessionError) {
      console.error("❌ Failed to fetch stale sessions:", sessionError);
      return;
    }

    if (!staleSessions || staleSessions.length === 0) {
      return;
    }

    console.log(`🔍 Found ${staleSessions.length} stale operator sessions`);

    for (const session of staleSessions) {
      // Mark operator as offline
      await supabase
        .from("operator_sessions")
        .update({
          status: "offline",
        })
        .eq("operator_id", session.operator_id);

      // If they had an active queue item, release it
      if (session.current_queue_id) {
        console.log(
          `🔄 Releasing queue ${session.current_queue_id} due to stale heartbeat`,
        );

        // Try regular queue
        const { data: regularRows } = await supabase
          .from("message_queue")
          .update({
            status: "pending",
            assigned_operator_id: null,
            assigned_at: null,
            expires_at: null,
            conversation_assigned: false,
          })
          .eq("id", session.current_queue_id)
          .eq("status", "assigned")
          .select();

        // If released, clear conversation ownership
        if (regularRows?.length > 0) {
          const conversationId = regularRows[0].conversation_id;
          if (conversationId) {
            await supabase
              .from("conversations")
              .update({
                active_operator_id: null,
                active_operator_device: null,
                active_operator_at: null,
              })
              .eq("id", conversationId);
            console.log(
              `✅ Released and cleared ownership for conversation ${conversationId}`,
            );
          }
        }

        // Try stopped queue
        const { data: stoppedRows } = await supabase
          .from("stopped_queue")
          .update({
            status: "pending",
            assigned_operator_id: null,
            assigned_at: null,
            expires_at: null,
          })
          .eq("id", session.current_queue_id)
          .eq("status", "assigned")
          .select();

        if (stoppedRows?.length > 0) {
          const conversationId = stoppedRows[0].conversation_id;
          if (conversationId) {
            await supabase
              .from("conversations")
              .update({
                active_operator_id: null,
                active_operator_device: null,
                active_operator_at: null,
              })
              .eq("id", conversationId);
          }
        }

        // Try poke queue
        await supabase
          .from("poke_queue")
          .update({
            status: "pending",
            assigned_poker_id: null,
            assigned_at: null,
            expires_at: null,
          })
          .eq("id", session.current_queue_id)
          .eq("status", "assigned");
      }
    }

    if (staleSessions.length > 0) {
      console.log(
        `✅ Released ${staleSessions.length} stale operator assignments`,
      );
    }
  } catch (err) {
    console.error("Stale operator cleanup error:", err);
  }
};

// Run stale operator cleanup every 2 minutes
setInterval(cleanupStaleOperators, 2 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Operator API running on port ${PORT}`);
});
