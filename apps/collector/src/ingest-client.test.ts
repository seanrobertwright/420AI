import { describe, it, expect, vi, afterEach } from "vitest";
import { postPair, postIngest } from "./ingest-client.js";
import type { IngestBatch } from "@420ai/shared";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ingest-client", () => {
  it("postIngest sends the bearer header + JSON body and parses the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { recordsInserted: 2, eventsUpserted: 3 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const batch: IngestBatch = {
      records: [
        { sourceConnector: "claude-code", sessionId: "s1", sourceRecordId: "r1", payload: "{}" },
      ],
      events: [],
    };
    const result = await postIngest("http://localhost:8420/", "tok123", batch);

    expect(result).toEqual({ recordsInserted: 2, eventsUpserted: 3 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:8420/v1/ingest"); // trailing slash trimmed
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok123");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(batch);
  });

  it("postIngest throws a useful error on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid or revoked token" })),
    );
    await expect(postIngest("http://localhost:8420", "bad", { records: [], events: [] })).rejects.toThrow(
      /ingest failed: HTTP 401/,
    );
  });

  it("postPair posts the pairing body (no auth header)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { token: "t", machineId: "m" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postPair("http://localhost:8420", {
      code: "abc",
      machine: { name: "win-dev" },
    });
    expect(result).toEqual({ token: "t", machineId: "m" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:8420/v1/pair");
    expect(init.headers.authorization).toBeUndefined();
  });
});
