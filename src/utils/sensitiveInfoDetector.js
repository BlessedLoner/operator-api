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

  // Remove spaces between digits
  normalized = normalized.replace(/(\d)\s+(\d)/g, "$1$2");

  // Replace word numbers with digits
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

  // Spaced: 1 2 3 4 5 6 7 8 9 0
  /\b\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\b/g,

  // Mixed: 1 2 three 4 five 6 seven 8 nine 0
  /(?:one|on|1)\s*[-.\s]*\s*(?:two|tow|to|2)\s*[-.\s]*\s*(?:three|tree|3)\s*[-.\s]*\s*(?:four|fore|4)\s*[-.\s]*\s*(?:five|fiv|5)\s*[-.\s]*\s*(?:six|sex|6)\s*[-.\s]*\s*(?:seven|sevn|7)\s*[-.\s]*\s*(?:eight|eit|8)\s*[-.\s]*\s*(?:nine|nin|9)\s*[-.\s]*\s*(?:zero|0|oh)/gi,

  // Dotted: 1.2.3.4.5.6.7.8.9.0
  /\b\d\.\d\.\d\.\d\.\d\.\d\.\d\.\d\.\d\.\d\b/g,

  // Unicode digits
  /[𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡]{7,}/g,

  // 9-digit word pattern (for incomplete numbers)
  /\b(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\s*[-.\s]*\s*(one|on|two|tow|to|three|tree|four|fore|five|fiv|six|sex|seven|sevn|eight|eit|nine|nin|zero|oh)\b/gi,
];

// Email patterns
const EMAIL_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b[A-Z0-9._%+-]+\s*\[at\]\s*[A-Z0-9.-]+\s*\[dot\]\s*[A-Z]{2,}\b/gi,
  /\b[A-Z0-9._%+-]+\s*\(at\)\s*[A-Z0-9.-]+\s*\(dot\)\s*[A-Z]{2,}\b/gi,
  /\b[A-Z0-9._%+-]+\s*at\s*[A-Z0-9.-]+\s*dot\s*[A-Z]{2,}\b/gi,
];

// Social patterns
const SOCIAL_PATTERNS = [
  /(whatsapp|whtsapp|whats app|whats-app|wa\.me|telegram|tgram|tg|t\.me|instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*[-.:]\s*\+?\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/gi,
  /(instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*[-.:]\s*@?[a-zA-Z0-9_.]{3,30}/gi,
];

// Context keywords
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
];

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect sensitive info in text
 */
export function detectSensitiveInfo(text) {
  if (!text || typeof text !== "string") {
    return { detected: false, type: null, masked: text, original: text };
  }

  let detected = false;
  let type = null;
  let maskedText = text;

  // Normalize text for detection
  const normalizedText = normalizeText(text);

  // Check phone numbers
  for (const pattern of PHONE_PATTERNS) {
    const matches = normalizedText.match(pattern);
    if (matches && matches.length > 0) {
      detected = true;
      type = "phone";
      for (const match of matches) {
        maskedText = maskedText.replace(
          new RegExp(escapeRegExp(match), "g"),
          "***********",
        );
      }
      break;
    }
  }

  // Check emails
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

  // Check social
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

  // Context check (catch numbers in context)
  if (!detected) {
    const hasContext = CONTEXT_KEYWORDS.some((keyword) =>
      text.toLowerCase().includes(keyword),
    );

    if (hasContext) {
      const numberMatches = text.match(/\b\d{5,}\b/g);
      if (numberMatches && numberMatches.length > 0) {
        detected = true;
        type = "phone";
        for (const match of numberMatches) {
          maskedText = maskedText.replace(
            new RegExp(escapeRegExp(match), "g"),
            "***********",
          );
        }
      }
    }
  }

  return { detected, type, masked: maskedText, original: text };
}

/**
 * Check if operator message should be blocked
 */
export function isOperatorMessageBlocked(text) {
  if (!text || typeof text !== "string") return false;

  const result = detectSensitiveInfo(text);
  if (result.detected) return true;

  // Personal patterns
  const personalPatterns = [
    /my\s*(phone|number|whatsapp|telegram|social|insta|ig|email|contact|cell|mobile)/gi,
    /contact\s*me\s*(at|on|via)/gi,
    /dm\s*me/gi,
    /send\s*me\s*(a\s*)?message/gi,
    /text\s*me/gi,
    /call\s*me/gi,
    /reach\s*me/gi,
    /here's\s*my/gi,
    /here is\s*my/gi,
    /you can\s*(call|text|reach|contact|message)/gi,
    /add\s*me\s*on/gi,
  ];

  const normalized = text.toLowerCase().replace(/\s+/g, " ");

  for (const pattern of personalPatterns) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Check for number sequences
  if (/\b\d{5,}\b/.test(normalized)) {
    return true;
  }

  return false;
}
