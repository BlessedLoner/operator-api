/**
 * Detects sensitive information (phone numbers, emails, social media)
 * Enhanced with better pattern matching and normalization
 */

// Number word mapping (with common typos)
const NUMBER_WORDS = {
  one: "1",
  on: "1",
  two: "2",
  tow: "2",
  to: "2",
  three: "3",
  tree: "3",
  four: "4",
  fore: "4",
  five: "5",
  fiv: "5",
  six: "6",
  sex: "6",
  seven: "7",
  sevn: "7",
  eight: "8",
  eit: "8",
  nine: "9",
  nin: "9",
  zero: "0",
  oh: "0",
};

// Unicode digit mapping
const UNICODE_DIGITS = {
  "𝟘": "0",
  "𝟙": "1",
  "𝟚": "2",
  "𝟛": "3",
  "𝟜": "4",
  "𝟝": "5",
  "𝟞": "6",
  "𝟟": "7",
  "𝟠": "8",
  "𝟡": "9",
  "０": "0",
  "１": "1",
  "２": "2",
  "３": "3",
  "４": "4",
  "５": "5",
  "６": "6",
  "７": "7",
  "８": "8",
  "９": "9",
};

// Normalize text before detection
function normalizeText(text) {
  let normalized = text;

  // Replace Unicode digits
  for (const [unicode, ascii] of Object.entries(UNICODE_DIGITS)) {
    normalized = normalized.replace(new RegExp(unicode, "g"), ascii);
  }

  // Remove spaces between digits (but keep word boundaries)
  normalized = normalized.replace(/(\d)\s+(\d)/g, "$1$2");

  // Replace word numbers with digits (only standalone words)
  for (const [word, num] of Object.entries(NUMBER_WORDS)) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    normalized = normalized.replace(regex, num);
  }

  return normalized;
}

// Enhanced phone patterns
const PHONE_PATTERNS = [
  // Standard formats
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
  /\b\(\d{3}\)\s?\d{3}[-.]?\d{4}\b/g,
  /\b\d{3}\s\d{3}\s\d{4}\b/g,
  /\b\d{10}\b/g,
  /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,

  // Obfuscated: one two three four five six seven eight nine zero
  /\b(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\b/gi,

  // Combined words with separators: one-two-three-four
  /\b(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)[-._\s]*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\b/gi,

  // Spaced: 1 2 3 4 5 6 7 8 9 0
  /\b\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\b/g,

  // Mixed: 1 2 three 4 five 6 seven 8 nine 0
  /(?:one|on|1)\s*[-.\s]*\s*(?:two|tow|to|2)\s*[-.\s]*\s*(?:three|tree|3)\s*[-.\s]*\s*(?:four|fore|4)\s*[-.\s]*\s*(?:five|fiv|5)\s*[-.\s]*\s*(?:six|sex|6)\s*[-.\s]*\s*(?:seven|sevn|7)\s*[-.\s]*\s*(?:eight|eit|8)\s*[-.\s]*\s*(?:nine|nin|9)\s*[-.\s]*\s*(?:zero|0|oh)/gi,

  // Dotted: 1.2.3.4.5.6.7.8.9.0
  /\b\d\.\d\.\d\.\d\.\d\.\d\.\d\.\d\.\d\.\d\b/g,

  // Unicode digits: 𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵𝟬 (detected through normalization)
  /[𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡]{7,}/g,
];

// Email patterns (enhanced)
const EMAIL_PATTERNS = [
  // Standard emails
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,

  // Obfuscated: name [at] gmail [dot] com
  /\b[A-Z0-9._%+-]+\s*\[at\]\s*[A-Z0-9.-]+\s*\[dot\]\s*[A-Z]{2,}\b/gi,

  // Obfuscated: name (at) gmail (dot) com
  /\b[A-Z0-9._%+-]+\s*\(at\)\s*[A-Z0-9.-]+\s*\(dot\)\s*[A-Z]{2,}\b/gi,

  // Obfuscated: name at gmail dot com
  /\b[A-Z0-9._%+-]+\s*at\s*[A-Z0-9.-]+\s*dot\s*[A-Z]{2,}\b/gi,

  // Obfuscated: name [@] gmail [.] com
  /\b[A-Z0-9._%+-]+\s*\[@\]\s*[A-Z0-9.-]+\s*\[\.\]\s*[A-Z]{2,}\b/gi,
];

// Social patterns (enhanced)
const SOCIAL_PATTERNS = [
  /(whatsapp|whtsapp|whats app|whats-app|wa\.me|telegram|tgram|tg|t\.me|instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*[-.:]\s*\+?\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/gi,
  /(instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*[-.:]\s*@?[a-zA-Z0-9_.]{3,30}/gi,

  // WhatsApp/Telegram with variations
  /(whatsapp|whtsapp|whats app|whats-app|telegram|tgram|tg)\s*[:.]?\s*(\+?\d[\d\s\-]{6,}\d)/gi,

  // Social media with "at"
  /(instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*at\s*@?[a-zA-Z0-9_.]{3,30}/gi,
];

// Context keywords (expanded)
const CONTEXT_KEYWORDS = [
  "call me",
  "text me",
  "contact me",
  "my number",
  "reach me",
  "whatsapp",
  "telegram",
  "dm me",
  "message me",
  "phone me",
  "ring me",
  "get me on",
  "find me at",
  "connect with me",
  "my phone",
  "my cell",
  "my mobile",
  "my whatsapp",
  "my telegram",
  "my social",
  "my insta",
  "my ig",
  "my email",
  "my mail",
  "send me",
];

// Personal patterns for operator blocking (expanded)
const PERSONAL_PATTERNS = [
  /my\s*(phone|number|whatsapp|telegram|social|insta|ig|email|contact|whats app|whats-app|cell|mobile|handphone)/gi,
  /contact\s*me\s*(at|on|via)/gi,
  /dm\s*me/gi,
  /send\s*me\s*(a\s*)?message/gi,
  /text\s*me/gi,
  /call\s*me/gi,
  /reach\s*me/gi,
  /get\s*in\s*touch/gi,
  /here's\s*my/gi,
  /here is\s*my/gi,
  /this is\s*my/gi,
  /you can\s*(call|text|reach|contact|message|whatsapp|telegram)/gi,
  /add\s*me\s*on/gi,
  /follow\s*me\s*on/gi,
  /ping\s*me/gi,
  /hit\s*me\s*up/gi,
  /slide\s*into\s*my/gi,
  /shoot\s*me\s*a\s*(message|text)/gi,
  /give\s*me\s*a\s*(call|ring|buzz)/gi,
  /drop\s*me\s*a\s*(line|message|text)/gi,
  /my\s*(contact|social media|username|handle)/gi,
];

// Detect sensitive info in text
export function detectSensitiveInfo(text) {
  if (!text || typeof text !== "string") {
    return { detected: false, type: null, masked: text, original: text };
  }

  let detected = false;
  let type = null;
  let maskedText = text;

  // Normalize text for detection
  const normalizedText = normalizeText(text);

  // Check phone numbers using normalized text
  for (const pattern of PHONE_PATTERNS) {
    const matches = normalizedText.match(pattern);
    if (matches && matches.length > 0) {
      detected = true;
      type = "phone";

      // Find the original matches in the original text
      for (const match of matches) {
        // Try to find the original text that matches this pattern
        // This is a simplified approach - for production, you'd want to map back
        maskedText = maskedText.replace(
          new RegExp(escapeRegExp(match), "g"),
          "***********",
        );
      }
      break;
    }
  }

  // Check emails (if not already detected)
  if (!detected) {
    for (const pattern of EMAIL_PATTERNS) {
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        detected = true;
        type = "email";
        for (const match of matches) {
          const parts = match.split(/[@\s\[\(]at[\]\)\s]/i);
          const domain =
            parts.length > 1
              ? parts[1].split(/[\s\[\(]dot[\]\)\s]/i)[0]
              : "domain";
          maskedText = maskedText.replace(
            new RegExp(escapeRegExp(match), "g"),
            `***********@${domain}`,
          );
        }
        break;
      }
    }
  }

  // Check social (if not already detected)
  if (!detected) {
    for (const pattern of SOCIAL_PATTERNS) {
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        detected = true;
        type = "social";
        for (const match of matches) {
          maskedText = maskedText.replace(
            new RegExp(escapeRegExp(match), "g"),
            "***********",
          );
        }
        break;
      }
    }
  }

  // Additional context check (if not already detected)
  if (!detected) {
    const hasContext = CONTEXT_KEYWORDS.some((keyword) =>
      text.toLowerCase().includes(keyword),
    );

    if (hasContext) {
      // Look for number sequences (5+ digits) in the original text
      const numberMatches = text.match(/\b\d{5,}\b/g);
      if (numberMatches && numberMatches.length > 0) {
        for (const match of numberMatches) {
          detected = true;
          type = "phone";
          maskedText = maskedText.replace(
            new RegExp(escapeRegExp(match), "g"),
            "***********",
          );
        }
      }

      // Also check normalized text for number sequences
      if (!detected) {
        const normalizedNumberMatches = normalizedText.match(/\b\d{5,}\b/g);
        if (normalizedNumberMatches && normalizedNumberMatches.length > 0) {
          detected = true;
          type = "phone";
          // Mask the entire segment
          maskedText = "***********";
        }
      }
    }
  }

  return { detected, type, masked: maskedText, original: text };
}

// Check if operator message should be blocked
export function isOperatorMessageBlocked(text) {
  if (!text || typeof text !== "string") return false;

  // First check for sensitive info
  const result = detectSensitiveInfo(text);
  if (result.detected) return true;

  // Normalize text for better detection
  const normalized = text.toLowerCase().replace(/\s+/g, " ");

  // Check personal patterns
  for (const pattern of PERSONAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Check for number sequences (5+ digits)
  const numberSequence = normalized.match(/\b\d{5,}\b/g);
  if (numberSequence && numberSequence.length > 0) {
    return true;
  }

  // Check for "number" followed by digits
  if (/number\s*[:\-]?\s*\d{3,}/gi.test(normalized)) {
    return true;
  }

  // Check for encoded numbers (e.g., "one two three")
  const wordNumbers = normalized.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|zero|oh)\b/gi,
  );
  if (wordNumbers && wordNumbers.length >= 5) {
    return true;
  }

  return false;
}

// Helper function to escape regex special characters
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Export for use in other modules
export const SENSITIVE_INFO_TYPES = {
  PHONE: "phone",
  EMAIL: "email",
  SOCIAL: "social",
};
