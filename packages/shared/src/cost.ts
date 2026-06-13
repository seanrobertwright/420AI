import type { NormalizedTokens } from "./tokens.js";
import { getPricing } from "./pricing.js";

/**
 * Cost confidence ladder (PRD §13.3), most → least trustworthy:
 * - "exact"                    — a tool reported actual cost (no V1 connector does)
 * - "estimated-model-known"    — tokens × catalog pricing for a known model
 * - "estimated-model-unknown"  — model present but absent from the catalog
 * - "subscription-amortized"   — flat-fee plan amortized (later milestone)
 * - "unknown"                  — no model / no basis to cost
 *
 * The lowest-confidence label in a mixed session wins (see report renderer).
 */
export type CostConfidence =
  | "exact"
  | "estimated-model-known"
  | "estimated-model-unknown"
  | "subscription-amortized"
  | "unknown";

export interface CostResult {
  usd: number;
  confidence: CostConfidence;
  model?: string;
  pricingAsOf?: string;
}

/**
 * Compute cost from tokens × catalog pricing (PRD §13.1).
 *
 * - model known in catalog  → usd = Σ(tokens_subtype × rate), "estimated-model-known"
 * - model present, no entry → usd 0, "estimated-model-unknown"
 * - no model                → usd 0, "unknown"
 *
 * "exact" is unreachable in V1 (no tool reports actual cost) — it lives in the
 * type for later connectors that surface billed amounts directly.
 */
export function computeCost(
  model: string | undefined,
  tokens: NormalizedTokens,
): CostResult {
  if (!model) {
    return { usd: 0, confidence: "unknown" };
  }

  const pricing = getPricing(model);
  if (!pricing) {
    return { usd: 0, confidence: "estimated-model-unknown", model };
  }

  const usd =
    tokens.input * pricing.input +
    tokens.output * pricing.output +
    tokens.cache_read * pricing.cache_read +
    tokens.cache_write * pricing.cache_write;

  return {
    usd,
    confidence: "estimated-model-known",
    model,
    pricingAsOf: pricing.asOf,
  };
}
