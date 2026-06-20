import { ingestUrl, adminHeaders } from "@/lib/ingest";

/**
 * SSE pass-through proxy (M9, D8). The browser opens `new EventSource("/api/monitor/stream")`
 * (same-origin, no auth header); the Next server adds the admin bearer on the server→ingest
 * hop and streams the upstream `ReadableStream` body straight through unchanged. `force-dynamic`
 * + try/catch→502 (a refused upstream throws — spike gotchas #5).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let upstream: Response;
  try {
    upstream = await fetch(`${ingestUrl()}/v1/monitor/stream`, {
      headers: await adminHeaders(),
      cache: "no-store",
      // Tie the upstream stream to the browser connection: when the client closes its
      // EventSource, this aborts the Next→ingest hop too (no leaked upstream stream).
      signal: request.signal,
    });
  } catch {
    return new Response("ingest unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("ingest error", { status: 502 });
  }
  // Pipe the upstream event-stream through unchanged.
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
