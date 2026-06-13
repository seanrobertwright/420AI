/**
 * The single normalized token shape every connector targets (PRD §10.3).
 *
 * Each connector maps its own vendor-specific usage fields onto these sub-types.
 * `total` is DERIVED (input + output + cache_read + cache_write) — see computeTotal.
 * `reasoning` and `tool` are 0 for Claude in V1 (Claude folds thinking into
 * output_tokens, and server_tool_use reports request counts, not tokens); they
 * exist so connectors like Codex/Gemini can populate them later.
 */
export interface NormalizedTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  tool: number;
  total: number;
}

/** A zeroed NormalizedTokens — the additive identity for addTokens. */
export const zeroTokens = (): NormalizedTokens => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  tool: 0,
  total: 0,
});

/** Field-wise sum of two token records (used to aggregate across a session). */
export const addTokens = (a: NormalizedTokens, b: NormalizedTokens): NormalizedTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_write: a.cache_write + b.cache_write,
  reasoning: a.reasoning + b.reasoning,
  tool: a.tool + b.tool,
  total: a.total + b.total,
});

/**
 * Derive the canonical total. Deliberately excludes `reasoning`/`tool` in V1:
 * for Claude they are 0, and including them once they are populated by other
 * connectors would double-count (reasoning is already inside output for Claude).
 */
export const computeTotal = (t: NormalizedTokens): number =>
  t.input + t.output + t.cache_read + t.cache_write;
