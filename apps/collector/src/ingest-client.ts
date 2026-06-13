import type { PairRequest, PairResponse, IngestBatch, IngestResponse } from "@420ai/shared";

/**
 * Thin ingest API client over Node 24's global fetch (no runtime dependency).
 * No durable queue yet (M3) — these are direct requests that fail loudly on a
 * non-2xx response. Library file: throws, never logs.
 */

function trimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${what} failed: HTTP ${res.status} ${res.statusText} — ${body}`);
  }
}

export async function postPair(baseUrl: string, body: PairRequest): Promise<PairResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await expectOk(res, "pair");
  return (await res.json()) as PairResponse;
}

export async function postIngest(
  baseUrl: string,
  token: string,
  batch: IngestBatch,
): Promise<IngestResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(batch),
  });
  await expectOk(res, "ingest");
  return (await res.json()) as IngestResponse;
}
