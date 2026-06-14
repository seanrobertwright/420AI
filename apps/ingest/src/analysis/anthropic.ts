import type { AnalysisProviderConfig, AnalysisRequest, AnalysisResult } from "./provider.js";
import { AnalysisProviderError } from "./provider.js";

/**
 * Anthropic Messages API client (PRD §16.2). Plain `fetch` — NO SDK dependency
 * (Scope Decision 3). Wire shape reconciled with the built-in `claude-api` skill:
 *   POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
 *   body:    { model, max_tokens, system?, messages: [{ role, content }] }
 *   resp:    { content: [{ type:"text", text }], model, usage:{ input_tokens, output_tokens } }
 *
 * Silent library (CLAUDE.md): wraps non-200 / timeout / parse / empty-output in
 * `AnalysisProviderError` so the route maps them to a clean 502 (never a leaked 500).
 */

interface AnthropicResponse {
  content?: { type?: string; text?: string }[];
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function anthropicInterpret(
  cfg: AnalysisProviderConfig,
  req: AnalysisRequest,
): Promise<AnalysisResult> {
  let json: AnthropicResponse;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      throw new AnalysisProviderError(`anthropic provider returned ${res.status}`);
    }
    json = (await res.json()) as AnthropicResponse;
  } catch (err) {
    if (err instanceof AnalysisProviderError) throw err;
    // fetch reject, AbortSignal.timeout, or JSON parse failure.
    throw new AnalysisProviderError(
      `anthropic provider request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const markdown = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (!markdown) {
    throw new AnalysisProviderError("anthropic provider returned empty content");
  }

  return {
    markdown,
    model: json.model ?? cfg.model,
    usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
  };
}
