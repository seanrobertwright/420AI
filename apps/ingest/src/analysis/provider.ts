import { anthropicInterpret } from "./anthropic.js";
import { openaiInterpret } from "./openai.js";

/**
 * The Analysis Provider abstraction (PRD §16.2, CONTEXT "Analysis Provider" /
 * "OpenAI-Compatible Analysis Provider"). An INJECTED, configurable provider that
 * takes a redacted prompt and returns Markdown findings. Injected via
 * `BuildAppOptions` (the proven `buildApp` db/adminToken pattern, D6) so ALL
 * automated tests use a deterministic stub — the live `fetch` runs only in
 * `server.ts` and manual validation.
 *
 * Silent library (CLAUDE.md): the clients throw `AnalysisProviderError`, never log.
 * No SDK dependency (Scope Decision 3) — plain `fetch` + `AbortSignal.timeout`.
 */

export interface AnalysisRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
}

export interface AnalysisResult {
  markdown: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AnalysisProvider {
  interpret(req: AnalysisRequest): Promise<AnalysisResult>;
}

/**
 * A clean, mappable failure for ANY provider problem (non-200, timeout, parse,
 * empty output, not-configured). The route's error handler maps `unavailable` → 502
 * and `not_configured` → 503 (D10) so a provider problem is never a leaked 500.
 */
export class AnalysisProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "not_configured" = "unavailable",
  ) {
    super(message);
    this.name = "AnalysisProviderError";
  }
}

export interface AnalysisProviderConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

/** A provider that throws `not_configured` on use — boots cleanly, fails only the
 * interpretation endpoints with a 503 (D9). */
function notConfigured(): AnalysisProvider {
  return {
    async interpret(): Promise<AnalysisResult> {
      throw new AnalysisProviderError(
        "analysis provider not configured (set ANALYSIS_PROVIDER and ANALYSIS_API_KEY)",
        "not_configured",
      );
    },
  };
}

/**
 * Build the real provider from env config, dispatching on `provider`; or a
 * `notConfigured()` stand-in when `cfg` is null (D9 — the server still boots and all
 * M1–M7 endpoints work).
 */
export function createAnalysisProvider(cfg: AnalysisProviderConfig | null): AnalysisProvider {
  if (!cfg) return notConfigured();
  if (cfg.provider === "anthropic") {
    return { interpret: (req) => anthropicInterpret(cfg, req) };
  }
  return { interpret: (req) => openaiInterpret(cfg, req) };
}
