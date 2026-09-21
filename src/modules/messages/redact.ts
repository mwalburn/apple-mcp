/**
 * Best-effort masking of secrets before message text reaches the model.
 * People text each other passwords and banks text one-time codes; none of it
 * is needed to answer "what did X ask me" and all of it would otherwise land
 * in the conversation context.
 *
 * This is mitigation, not a guarantee: a secret phrased unusually will pass
 * through. Disable with APPLE_MCP_REDACT=off.
 */
const R = "[redacted]";

const RULES: { name: string; re: RegExp; replace: (m: string, ...g: string[]) => string }[] = [
  // "password: hunter2", "Password is hunter2", "pw - hunter2", "PIN: 1234"
  { name: "credential",
    re: /\b(pass(?:word|code|phrase)?|pwd|pw|pin|passkey|secret|api[ _-]?key|token)\b(\s*(?:is|was|=|:|-|–)\s*)(\S+)/gi,
    replace: (_m, label, sep) => `${label}${sep}${R}` },
  // "Username: x" is not secret on its own, but it is one half of a login; keep it. Deliberately no rule.
  // One-time codes: a standalone 4-8 digit run in a message that names a code.
  // Digits glued to letters (DL1234) or a currency sign are not codes.
  { name: "otp",
    re: /^(?=[\s\S]*\b(?:code|one[- ]time|otp|2fa|passcode)\b)[\s\S]*$/i,
    replace: (m) => m.replace(/(?<![\w$€£-])\d{4,8}(?![\w-])/g, R) },
  // Secret-sharing links. The URL itself is the credential: anyone holding it can open the item.
  { name: "secret-link",
    re: /https?:\/\/(?:share\.1password\.com|send\.bitwarden\.com|(?:www\.)?onetimesecret\.com|(?:www\.)?privnote\.com|pwpush\.com|(?:www\.)?password\.link|vault\.bitwarden\.com\/#\/send|yopass\.se)\/\S+/gi,
    replace: (m) => `${new URL(m).origin}/${R}` },
  // Payment card numbers: 13-19 digits, optionally grouped.
  { name: "card", re: /\b(?:\d[ -]?){12,18}\d\b/g, replace: () => R },
  // US SSN
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, replace: () => R },
];

export function redact(text: string | null): { text: string | null; redacted: boolean } {
  if (!text) return { text, redacted: false };
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.replace as any);
  return { text: out, redacted: out !== text };
}

export function redactionEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.APPLE_MCP_REDACT ?? "on").toLowerCase() !== "off";
}
