/**
 * Model pricing catalog (PRD §13.1–§13.2).
 *
 * All rates are USD per **single token** (per-MTok ÷ 1e6). Keying is by the
 * EXACT model id the connector writes (Claude Code writes e.g. "claude-opus-4-8"
 * with no date suffix for current models).
 *
 * cache_read seeds to 0.1× input; cache_write seeds to the 5-minute ephemeral
 * rate (1.25× input). The real record also carries a 1-hour cache tier at 2×
 * input — V1 collapses both into cache_write while the raw record preserves the
 * split, so a later parser_version can price them separately (replay, PRD §23).
 *
 * Source: Anthropic public API pricing, June 2026.
 */
export interface ModelPricing {
  /** USD per single input token. */
  input: number;
  /** USD per single output token. */
  output: number;
  /** USD per single cached-read token. */
  cache_read: number;
  /** USD per single cache-write (creation) token. */
  cache_write: number;
  sourceUrl: string;
  asOf: string;
}

const ANTHROPIC_SOURCE = "https://www.anthropic.com/pricing";
const OPENAI_SOURCE = "https://openai.com/api/pricing/";
const GEMINI_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
const AS_OF = "2026-06-13";

/**
 * Pricing-catalog identity stamped on events + report artifacts (PRD §23). Bump
 * when `PRICING_CATALOG` rates change so a replay can distinguish records priced
 * under an older catalog. Independent of `AS_OF` (the human date) and of the
 * event fingerprint (PRD §12 — a metadata column, never a fingerprint input).
 */
export const PRICING_CATALOG_VERSION = "m10-catalog-v1" as const;

export const PRICING_CATALOG: Record<string, ModelPricing> = {
  // Opus 4.8 — $5 / $25 per MTok; cache_read 0.1× input; cache_write 1.25× input.
  "claude-opus-4-8": {
    input: 5e-6,
    output: 25e-6,
    cache_read: 0.5e-6,
    cache_write: 6.25e-6,
    sourceUrl: ANTHROPIC_SOURCE,
    asOf: AS_OF,
  },
  // Sonnet 4.6 — $3 / $15 per MTok.
  "claude-sonnet-4-6": {
    input: 3e-6,
    output: 15e-6,
    cache_read: 0.3e-6,
    cache_write: 3.75e-6,
    sourceUrl: ANTHROPIC_SOURCE,
    asOf: AS_OF,
  },
  // Haiku 4.5 — $1 / $5 per MTok.
  "claude-haiku-4-5-20251001": {
    input: 1e-6,
    output: 5e-6,
    cache_read: 0.1e-6,
    cache_write: 1.25e-6,
    sourceUrl: ANTHROPIC_SOURCE,
    asOf: AS_OF,
  },
  // Codex CLI — OpenAI GPT-5.5: $5 / $30 per MTok; cached input $0.50/MTok.
  // No separate cache-write tier — Codex maps cache_write to 0 tokens (M4 D1),
  // so the cache_write rate (= input) is never actually multiplied by tokens.
  "gpt-5.5": {
    input: 5e-6,
    output: 30e-6,
    cache_read: 0.5e-6,
    cache_write: 5e-6,
    sourceUrl: OPENAI_SOURCE,
    asOf: AS_OF,
  },
  // Codex CLI — OpenAI GPT-5.4 (older on-disk sessions): $2.50 / $15 per MTok;
  // cached input $0.25/MTok (10% of input).
  "gpt-5.4": {
    input: 2.5e-6,
    output: 15e-6,
    cache_read: 0.25e-6,
    cache_write: 2.5e-6,
    sourceUrl: OPENAI_SOURCE,
    asOf: AS_OF,
  },
  // Gemini CLI — Gemini 3 Flash (preview): $0.50 / $3.00 per MTok; cached $0.05/MTok.
  // Gemini maps cache_write to 0 tokens (M4 D1) — cache_write rate (= input) unused.
  "gemini-3-flash-preview": {
    input: 0.5e-6,
    output: 3e-6,
    cache_read: 0.05e-6,
    cache_write: 0.5e-6,
    sourceUrl: GEMINI_SOURCE,
    asOf: AS_OF,
  },
};

/** Look up pricing by exact model id; undefined if the model is not catalogued. */
export function getPricing(model: string): ModelPricing | undefined {
  return PRICING_CATALOG[model];
}
