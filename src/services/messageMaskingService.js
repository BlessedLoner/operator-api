// src/services/messageMaskingService.js
import {
  detectSensitiveInfo,
  isOperatorMessageBlocked,
} from "../utils/sensitiveInfoDetector.js";

export async function maskUserMessage(
  supabase,
  conversationId,
  userId,
  content,
) {
  const result = detectSensitiveInfo(content);

  if (result.detected) {
    try {
      await supabase.from("flagged_messages").insert({
        conversation_id: conversationId,
        user_id: userId,
        original_content: content,
        masked_content: result.masked,
        detection_type: result.type,
        detected_at: new Date().toISOString(),
        reviewed: false,
      });
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

export async function validateOperatorMessage(supabase, content, operatorId) {
  const isBlocked = isOperatorMessageBlocked(content);

  if (isBlocked) {
    try {
      await supabase.from("operator_violations").insert({
        operator_id: operatorId,
        attempted_content: content,
        detected_at: new Date().toISOString(),
        action_taken: "blocked_and_logout",
        resolved: false,
      });

      const { data: managers } = await supabase
        .from("managers")
        .select("email")
        .eq("is_active", true);

      console.log(
        `🚨 OPERATOR VIOLATION: Operator ${operatorId} attempted to send: "${content}"`,
      );
      console.log(`📧 Would notify ${managers?.length || 0} managers`);
    } catch (err) {
      console.error("Failed to log operator violation:", err);
    }
  }

  return {
    isBlocked,
    canSend: !isBlocked,
  };
}
