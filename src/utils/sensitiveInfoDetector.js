// src/utils/sensitiveInfoDetector.js

/**
 * Detects sensitive information (phone numbers, emails, social media)
 */

// Number word mapping
const NUMBER_WORDS = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  zero: "0",
  oh: "0",
};

// Phone patterns (standard + obfuscated)
const PHONE_PATTERNS = [
  // Standard formats
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
  /\b\(\d{3}\)\s?\d{3}[-.]?\d{4}\b/g,
  /\b\d{3}\s\d{3}\s\d{4}\b/g,
  /\b\d{10}\b/g,
  /\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,

  // Obfuscated: one two three four five six seven eight nine zero
  /\b(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\s*[-.\s]*\s*(one|two|three|four|five|six|seven|eight|nine|zero|oh)\b/gi,

  // Spaced: 1 2 3 4 5 6 7 8 9 0
  /\b\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\s+\d\b/g,

  // Mixed: 1 2 three 4 five 6 seven 8 nine 0
  /(?:one|1)\s*[-.\s]*\s*(?:two|2)\s*[-.\s]*\s*(?:three|3)\s*[-.\s]*\s*(?:four|4)\s*[-.\s]*\s*(?:five|5)\s*[-.\s]*\s*(?:six|6)\s*[-.\s]*\s*(?:seven|7)\s*[-.\s]*\s*(?:eight|8)\s*[-.\s]*\s*(?:nine|9)\s*[-.\s]*\s*(?:zero|0|oh)/gi,
];

// Email patterns
const EMAIL_PATTERNS = [
  // Standard emails
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  // Obfuscated: name [at] gmail [dot] com
  /\b[A-Z0-9._%+-]+\s*\[at\]\s*[A-Z0-9.-]+\s*\[dot\]\s*[A-Z]{2,}\b/gi,
  // Obfuscated: name (at) gmail (dot) com
  /\b[A-Z0-9._%+-]+\s*\(at\)\s*[A-Z0-9.-]+\s*\(dot\)\s*[A-Z]{2,}\b/gi,
  // Obfuscated: name at gmail dot com
  /\b[A-Z0-9._%+-]+\s*at\s*[A-Z0-9.-]+\s*dot\s*[A-Z]{2,}\b/gi,
];

// Social patterns
const SOCIAL_PATTERNS = [
  /(whatsapp|wa\.me|telegram|t\.me|instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*[-.:]\s*\+?\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/gi,
  /(instagram|ig|twitter|x|facebook|fb|tiktok|snapchat)\s*[-.:]\s*@?[a-zA-Z0-9_.]{3,30}/gi,
];

// Detect sensitive info in text
export function detectSensitiveInfo(text) {
  if (!text || typeof text !== "string") {
    return { detected: false, type: null, masked: text, original: text };
  }

  let detected = false;
  let type = null;
  let maskedText = text;

  // Check phone numbers
  for (const pattern of PHONE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      detected = true;
      type = "phone";
      for (const match of matches) {
        maskedText = maskedText.replace(match, "***********");
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
          maskedText = maskedText.replace(match, `***********@${domain}`);
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
          maskedText = maskedText.replace(match, "***********");
        }
        break;
      }
    }
  }

  // Additional context check
  if (!detected) {
    const contextKeywords = [
      "call me",
      "text me",
      "contact me",
      "my number",
      "reach me",
      "whatsapp",
      "telegram",
      "dm me",
    ];
    const hasContext = contextKeywords.some((keyword) =>
      text.toLowerCase().includes(keyword),
    );

    if (hasContext) {
      const numberMatches = text.match(/\b\d+\b/g);
      if (numberMatches && numberMatches.length > 0) {
        for (const match of numberMatches) {
          if (match.length >= 5) {
            detected = true;
            type = "phone";
            maskedText = maskedText.replace(match, "***********");
          }
        }
      }
    }
  }

  return { detected, type, masked: maskedText, original: text };
}

// Check if operator message should be blocked
export function isOperatorMessageBlocked(text) {
  if (!text || typeof text !== "string") return false;

  const result = detectSensitiveInfo(text);

  // Extra checks for operator messages
  const personalPatterns = [
    /my\s*(phone|number|whatsapp|telegram|social|insta|ig|email)/gi,
    /contact\s*me\s*(at|on)/gi,
    /dm\s*me/gi,
    /send\s*me\s*(a\s*)?message/gi,
  ];

  for (const pattern of personalPatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return result.detected;
}
