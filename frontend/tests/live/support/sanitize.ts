export type SanitizedEvidence =
  | null
  | boolean
  | number
  | string
  | SanitizedEvidence[]
  | { [key: string]: SanitizedEvidence };

export const LIVE_BEARER_TOKEN_SENTINEL =
  "__VG_BEARER_TOKEN_" + "4378650e74bd__";

const SENSITIVE_KEY =
  /(?:password|passphrase|token|secret|authorization|cookie|credential|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|jwt)/i;
const SENSITIVE_STRING =
  /\b(password|passphrase|token|secret|authorization|cookie|credential|api[-_]?key|access[-_]?token|refresh[-_]?token)\s*[:=]\s*[^\s,;]+/gi;
const BEARER_VALUE = /\bBearer\s+[^\s]+/gi;
const BEARER_SENTINEL = /__VG_BEARER_TOKEN_[A-Za-z0-9]+__/g;
const BARE_JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const MODERN_SECRET = /\bsb_secret_[A-Za-z0-9][A-Za-z0-9_-]*\b/g;

function sanitizeString(value: string): string {
  let sanitized = value.replace(SENSITIVE_STRING, "$1=[REDACTED]");
  sanitized = sanitized.replace(BEARER_VALUE, "Bearer [REDACTED]");
  sanitized = sanitized.replace(BEARER_SENTINEL, "[REDACTED]");
  sanitized = sanitized.replace(BARE_JWT, "[REDACTED]");
  sanitized = sanitized.replace(MODERN_SECRET, "[REDACTED]");

  try {
    const url = new URL(sanitized);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Ordinary evidence strings are not URLs.
  }
  return sanitized;
}

function sanitizeValue(
  value: unknown,
  seen: WeakSet<object>,
): SanitizedEvidence {
  if (value === null) return null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const sanitized = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return sanitized;
  }

  const sanitized: { [key: string]: SanitizedEvidence } = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeValue(nestedValue, seen);
  }
  seen.delete(value);
  return sanitized;
}

export function sanitizeEvidence(value: unknown): SanitizedEvidence {
  return sanitizeValue(value, new WeakSet<object>());
}
