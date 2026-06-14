import type { AnalysisProviderConfig, AnalysisRequest, AnalysisResult } from "./provider.js";
import { AnalysisProviderError } from "./provider.js";

/**
 * OpenAI-compatible Chat Completions client (PRD §16.2; CONTEXT "OpenAI-Compatible
 * Analysis Provider") — works against Ollama / LM Studio / vLLM / OpenAI. Plain
 * `fetch`, NO SDK dependency (Scope Decision 3). Wire shape:
 *   POST {baseUrl}/chat/completions   (default base https://api.openai.com/v1)
 *   headers: authorization: Bearer <key>, content-type: application/json
 *   body:    { model, max_tokens, messages: [{role:"system"},{role:"user"}] }
 *   resp:    { choices:[{ message:{ content } }], model, usage:{ prompt_tokens, completion_tokens } }
 *
 * The `Authorization: Bearer` + `{error:{message,type,code}}` envelope were confirmed
 * against a local OpenAI-compatible proxy in spike 2. Silent library: wraps non-200 /
 * timeout / parse / empty-output in `AnalysisProviderError` (→ clean 502).
 */

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function openaiInterpret(
  cfg: AnalysisProviderConfig,
  req: AnalysisRequest,
): Promise<AnalysisResult> {
  const base = cfg.baseUrl ?? "https://api.openai.com/v1";
  let json: OpenAiResponse;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: req.maxOutputTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      throw new AnalysisProviderError(`openai-compatible provider returned ${res.status}`);
    }
    json = (await res.json()) as OpenAiResponse;
  } catch (err) {
    if (err instanceof AnalysisProviderError) throw err;
    throw new AnalysisProviderError(
      `openai-compatible provider request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const markdown = json.choices?.[0]?.message?.content ?? "";
  if (!markdown) {
    throw new AnalysisProviderError("openai-compatible provider returned empty content");
  }

  return {
    markdown,
    model: json.model ?? cfg.model,
    usage: {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    },
  };
}
