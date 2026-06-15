/**
 * The Redaction Pipeline (PRD §18, §18.2; CONTEXT "Redaction Pipeline" /
 * "Redaction Finding"). A PURE, dependency-free regex + entropy secret scanner:
 * `redact(text) -> { redacted, findings }`. It masks known key/token/credential/
 * PII/home-path patterns plus a high-entropy backstop, returning the masked text
 * and per-kind findings (METADATA ONLY — never the raw value).
 *
 * This is the first redaction code in the repo and the substrate the §21 searchable
 * redacted projection will later reuse. It is the §18 "redaction applies before AI
 * analysis or external export" gate: the orchestrator runs this over decrypted
 * transcript text BEFORE building a prompt, calling a provider, or storing anything.
 *
 * `@420ai/shared` invariants: no I/O, no `new Date()`, no deps. Mirrors the
 * `cost.ts`/`tokens.ts` "pure function + exported types" style.
 */

/** Redaction-ruleset identity stamped on artifacts (PRD §23) — bump if rules change. */
export const REDACTION_VERSION = "m8-redact-v1";

/**
 * A detected secret/PII span — METADATA ONLY. The raw matched value is NEVER
 * stored here (PRD §18 / CONTEXT "Redaction Finding": metadata *without exposing
 * the sensitive value*). A unit test asserts no finding contains the raw secret.
 */
export interface RedactionFinding {
  /** Logical category, e.g. "anthropic_key" | "email" | "high_entropy". */
  kind: string;
  /** Stable id of the rule that matched (for auditing). */
  ruleId: string;
  /** How many spans this rule masked. */
  count: number;
  /** The stable string that replaced each span, e.g. "[REDACTED:anthropic_key]". */
  placeholder: string;
}

export interface RedactionResult {
  redacted: string;
  findings: RedactionFinding[];
}

/** Stable placeholder for a kind — digit-free so the entropy pass never re-flags it. */
function placeholderFor(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/**
 * A regex rule. `mask` returns the replacement for a match; for most rules that is
 * just the placeholder, but `home_user_path` keeps the path structure and masks
 * only the captured username segment.
 */
interface Rule {
  ruleId: string;
  kind: string;
  /** Built fresh per `redact()` call so the global `lastIndex` is never shared. */
  build: () => RegExp;
  mask: (placeholder: string, ...groups: string[]) => string;
}

const PLACEHOLDER_MASK: Rule["mask"] = (placeholder) => placeholder;

/**
 * Rules in apply order: most-specific first so a specific kind wins over the broad
 * `generic_secret_assignment`, and the entropy backstop runs LAST. Each pattern is
 * anchored/bounded to avoid catastrophic backtracking; the multiline private-key
 * block is the only `[\s\S]` rule and is lazy.
 */
const RULES: Rule[] = [
  {
    ruleId: "private_key_block",
    kind: "private_key_block",
    build: () =>
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "jwt",
    kind: "jwt",
    build: () => /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "anthropic_key",
    kind: "anthropic_key",
    build: () => /sk-ant-[A-Za-z0-9_-]{20,}/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "openai_key",
    kind: "openai_key",
    build: () => /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "aws_access_key",
    kind: "aws_access_key",
    build: () => /AKIA[0-9A-Z]{16}/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "github_token",
    kind: "github_token",
    build: () => /gh[pousr]_[0-9A-Za-z]{36,}/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "google_api_key",
    kind: "google_api_key",
    build: () => /AIza[0-9A-Za-z_-]{35}/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "slack_token",
    kind: "slack_token",
    build: () => /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "connection_string",
    kind: "connection_string",
    // scheme://user:pass@  — mask the credentialed authority prefix only.
    build: () => /[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/gi,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "bearer_auth",
    kind: "bearer_auth",
    // Handle both assignment style ("authorization=token") and HTTP header style
    // ("Authorization: ******") — the optional `(?:bearer\s+)?` consumes
    // the scheme word so `\S+` always lands on the actual token value.
    build: () => /(?:authorization|bearer)\s*[:=]\s*(?:bearer\s+)?\S+/gi,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "generic_secret_assignment",
    kind: "generic_secret_assignment",
    build: () =>
      /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{6,}/gi,
    mask: PLACEHOLDER_MASK,
  },
  {
    ruleId: "home_user_path",
    kind: "home_user_path",
    // Mask ONLY the username segment; keep the surrounding path structure intact.
    // The username's first char excludes `[` so a prior `[REDACTED:*]` placeholder
    // is never re-matched (idempotence). The Windows separators use `\\+` so BOTH
    // the plain (`C:\Users\`) and the JSON-escaped (`C:\\Users\\`, as stored in a
    // verbatim JSONL raw record) forms are caught.
    build: () => /(\/home\/|\/Users\/|[A-Za-z]:\\+Users\\+)([^/\\\s[][^/\\\s]*)/g,
    mask: (placeholder, prefix) => `${prefix}${placeholder}`,
  },
  {
    ruleId: "email",
    kind: "email",
    build: () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    mask: PLACEHOLDER_MASK,
  },
];

/** Shannon entropy in bits/char. */
function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const ENTROPY_MIN_LEN = 24;
const ENTROPY_MIN_BITS = 4.0;

/**
 * True if `tok` looks like an unknown high-entropy secret: long enough, high
 * Shannon entropy, and mixed alphanumeric (digits + letters). The digit
 * requirement keeps ordinary long prose words out and — because placeholders are
 * digit-free — guarantees idempotence.
 */
function isHighEntropy(tok: string): boolean {
  if (tok.length < ENTROPY_MIN_LEN) return false;
  if (tok.includes("[REDACTED:")) return false;
  const hasDigit = /[0-9]/.test(tok);
  const hasAlpha = /[A-Za-z]/.test(tok);
  if (!hasDigit || !hasAlpha) return false;
  return shannonEntropy(tok) >= ENTROPY_MIN_BITS;
}

/**
 * Mask secrets/credentials/PII in `text`, returning the masked text and per-kind
 * findings (metadata only). Deterministic and idempotent: re-running on the output
 * is a no-op (placeholders contain no secret material and match no rule). NEVER
 * returns the raw matched value. The caller is contractually required to treat the
 * findings as non-sensitive metadata.
 */
export function redact(text: string): RedactionResult {
  const findings: RedactionFinding[] = [];
  let out = text;

  // Pass 1: known-pattern regex rules, most-specific first.
  for (const rule of RULES) {
    const placeholder = placeholderFor(rule.kind);
    let count = 0;
    out = out.replace(rule.build(), (...args) => {
      count++;
      // args = [match, ...captureGroups, offset, fullString, (groups?)] — pass only
      // the capture groups (everything between match and the numeric offset).
      const groups = args.slice(1, -2).map((g) => (g == null ? "" : String(g)));
      return rule.mask(placeholder, ...groups);
    });
    if (count > 0) {
      findings.push({ kind: rule.kind, ruleId: rule.ruleId, count, placeholder });
    }
  }

  // Pass 2: high-entropy backstop for unknown tokens (runs LAST so specific kinds win).
  const entropyPlaceholder = placeholderFor("high_entropy");
  let entropyCount = 0;
  out = out.replace(/[^\s"',;]+/g, (tok) => {
    if (!isHighEntropy(tok)) return tok;
    entropyCount++;
    return entropyPlaceholder;
  });
  if (entropyCount > 0) {
    findings.push({
      kind: "high_entropy",
      ruleId: "high_entropy",
      count: entropyCount,
      placeholder: entropyPlaceholder,
    });
  }

  return { redacted: out, findings };
}
