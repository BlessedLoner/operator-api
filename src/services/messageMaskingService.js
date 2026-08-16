import {
  detectSensitiveInfo,
  isOperatorMessageBlocked,
  SENSITIVE_INFO_TYPES,
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
  // Always detect and mask
  const result = detectSensitiveInfo(content);

  if (result.detected) {
    try {
      // Log the flagged message to the database
      const { error } = await supabase.from("flagged_messages").insert({
        conversation_id: conversationId,
        user_id: userId,
        original_content: content,
        masked_content: result.masked,
        detection_type: result.type,
        detected_at: new Date().toISOString(),
        reviewed: false,
      });

      if (error) {
        console.error("Failed to log flagged message:", error);
      } else {
        console.log(`🔒 Masked ${result.type} in message from user ${userId}`);
      }
    } catch (err) {
      console.error("Failed to log flagged message:", err);
    }
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
  const isBlocked = isOperatorMessageBlocked(content);

  if (isBlocked) {
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
        console.error("Failed to log operator violation:", error);
      }

      // Get managers for notification
      const { data: managers } = await supabase
        .from("managers")
        .select("email")
        .eq("is_active", true);

      // Log the violation (for monitoring)
      console.log(
        `🚨 OPERATOR VIOLATION: Operator ${operatorId} attempted to send: "${content}"`,
      );

      if (managers && managers.length > 0) {
        console.log(`📧 Would notify ${managers.length} managers`);
        // In production, you would send actual emails here
        // await sendManagerAlert(managers, operatorId, content);
      }

      // Set operator as offline
      await supabase
        .from("operator_sessions")
        .update({ status: "offline" })
        .eq("operator_id", operatorId);
    } catch (err) {
      console.error("Failed to process operator violation:", err);
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
