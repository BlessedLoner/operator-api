import {
  detectSensitiveInfo,
  isOperatorMessageBlocked,
} from "../utils/sensitiveInfoDetector.js";

/**
 * Mask user messages and log flagged content
 */
export async function maskUserMessage(
  supabase,
  conversationId,
  userId,
  content,
) {
  console.log(`🔍 [DEBUG] maskUserMessage called for user: ${userId}`);
  console.log(`📝 [DEBUG] Content: "${content}"`);

  // Always detect and mask
  const result = detectSensitiveInfo(content);

  console.log(`📊 [DEBUG] Detection result:`, {
    detected: result.detected,
    type: result.type,
    masked: result.masked,
  });

  if (result.detected) {
    console.log(
      `✅ [DEBUG] Sensitive info DETECTED! Logging to flagged_messages...`,
    );

    try {
      // Log the flagged message to the database
      const { data, error } = await supabase
        .from("flagged_messages")
        .insert({
          conversation_id: conversationId,
          user_id: userId,
          original_content: content,
          masked_content: result.masked,
          detection_type: result.type,
          detected_at: new Date().toISOString(),
          reviewed: false,
        })
        .select();

      if (error) {
        console.error("❌ [DEBUG] Failed to log flagged message:", error);
        console.error(
          "❌ [DEBUG] Error details:",
          JSON.stringify(error, null, 2),
        );
      } else {
        console.log(`✅ [DEBUG] Flagged message logged successfully!`, data);
        console.log(`🔒 Masked ${result.type} in message from user ${userId}`);
      }
    } catch (err) {
      console.error("❌ [DEBUG] Exception in flagged_messages insert:", err);
    }
  } else {
    console.log(`❌ [DEBUG] No sensitive info detected in: "${content}"`);
  }

  return {
    maskedContent: result.masked,
    wasMasked: result.detected,
    detectionType: result.type,
  };
}

/**
 * Validate and block operator messages
 */
export async function validateOperatorMessage(supabase, content, operatorId) {
  console.log(
    `🔍 [DEBUG] validateOperatorMessage called for operator: ${operatorId}`,
  );
  console.log(`📝 [DEBUG] Content: "${content}"`);

  const isBlocked = isOperatorMessageBlocked(content);
  console.log(`📊 [DEBUG] isBlocked: ${isBlocked}`);

  if (isBlocked) {
    console.log(`🚨 [DEBUG] OPERATOR VIOLATION DETECTED!`);

    try {
      // Log the violation
      const { error } = await supabase.from("operator_violations").insert({
        operator_id: operatorId,
        attempted_content: content,
        detected_at: new Date().toISOString(),
        action_taken: "blocked_and_logout",
        resolved: false,
      });

      if (error) {
        console.error("❌ [DEBUG] Failed to log operator violation:", error);
      } else {
        console.log(`✅ [DEBUG] Operator violation logged successfully!`);
      }

      // Get managers for notification
      const { data: managers } = await supabase
        .from("managers")
        .select("email")
        .eq("is_active", true);

      console.log(
        `🚨 OPERATOR VIOLATION: Operator ${operatorId} attempted to send: "${content}"`,
      );

      if (managers && managers.length > 0) {
        console.log(`📧 Would notify ${managers.length} managers`);
      }

      // Set operator as offline
      await supabase
        .from("operator_sessions")
        .update({ status: "offline" })
        .eq("operator_id", operatorId);
    } catch (err) {
      console.error("❌ [DEBUG] Failed to process operator violation:", err);
    }
  }

  return {
    isBlocked,
    canSend: !isBlocked,
  };
}

/**
 * Check if a message contains sensitive info (without logging)
 */
export function checkMessageSafety(content) {
  if (!content || typeof content !== "string") {
    return { safe: true, detected: false, type: null };
  }

  const result = detectSensitiveInfo(content);
  return {
    safe: !result.detected,
    detected: result.detected,
    type: result.type,
    masked: result.masked,
  };
}
