import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createAnalysisProvider,
  AnalysisProviderError,
  type AnalysisProviderConfig,
  type AnalysisRequest,
} from "./provider.js";

const REQ: AnalysisRequest = { system: "sys", user: "usr", maxOutputTokens: 100 };

const anthropicCfg: AnalysisProviderConfig = {
  provider: "anthropic",
  apiKey: "test-key",
  model: "claude-sonnet-4-6",
  timeoutMs: 1000,
};

const openaiCfg: AnalysisProviderConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "local-model",
  baseUrl: "http://localhost:11434/v1",
  timeoutMs: 1000,
};

/** A minimal Response-like stub (the clients use only .ok/.status/.json()). */
function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropic client", () => {
  it("posts the expected URL/headers/body and extracts markdown/model/usage", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        okJson({
          content: [
            { type: "text", text: "## Findings\n" },
            { type: "text", text: "more" },
          ],
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 11, output_tokens: 22 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAnalysisProvider(anthropicCfg).interpret(REQ);
    expect(result.markdown).toBe("## Findings\nmore");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
  });

  it("maps a non-200 to AnalysisProviderError (unavailable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    await expect(createAnalysisProvider(anthropicCfg).interpret(REQ)).rejects.toMatchObject({
      name: "AnalysisProviderError",
      kind: "unavailable",
    });
  });

  it("maps an aborted/timed-out fetch to AnalysisProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      }),
    );
    await expect(createAnalysisProvider(anthropicCfg).interpret(REQ)).rejects.toBeInstanceOf(
      AnalysisProviderError,
    );
  });

  it("treats empty content as a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ content: [], model: "m" })),
    );
    await expect(createAnalysisProvider(anthropicCfg).interpret(REQ)).rejects.toBeInstanceOf(
      AnalysisProviderError,
    );
  });
});

describe("openai-compatible client", () => {
  it("posts to {baseUrl}/chat/completions and extracts the choice content + usage", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        okJson({
          choices: [{ message: { content: "## Findings" } }],
          model: "local-model",
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createAnalysisProvider(openaiCfg).interpret(REQ);
    expect(result.markdown).toBe("## Findings");
    expect(result.model).toBe("local-model");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("maps a non-200 to AnalysisProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await expect(createAnalysisProvider(openaiCfg).interpret(REQ)).rejects.toBeInstanceOf(
      AnalysisProviderError,
    );
  });
});

describe("notConfigured provider", () => {
  it("throws AnalysisProviderError(kind: not_configured) on use", async () => {
    await expect(createAnalysisProvider(null).interpret(REQ)).rejects.toMatchObject({
      name: "AnalysisProviderError",
      kind: "not_configured",
    });
  });
});
