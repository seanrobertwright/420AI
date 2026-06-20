/**
 * SERVER-ONLY generalized ingest proxy (M12 12.2a, D8). Distilled verbatim from the
 * three M9/M10 monitor proxies (`api/monitor/route.ts`, `.../monitor/stream/route.ts`,
 * `.../alerts/firings/[id]/ack/route.ts`): the browser hits a same-origin Route Handler
 * with NO auth header, and these helpers add the admin bearer on the server→ingest hop
 * (the token is read from server env only and never reaches the browser).
 *
 * Adds the admin bearer via `adminHeaders()` (M12 12.3: the logged-in admin's session token
 * from the httpOnly cookie, read server-side) → NEVER import from a "use client" file; only
 * Route Handlers (`app/api/**`) may call these. `force-dynamic` belongs on each route file, not here.
 */
import { NextResponse } from "next/server";
import { ingestUrl, adminHeaders } from "@/lib/ingest";

type Init = { method?: string; body?: BodyInit | null; contentType?: string };

/**
 * Proxy a JSON request to ingest, adding the admin bearer on the server→ingest hop.
 * On `!res.ok` it FORWARDS the upstream status (so a page can show "not found" on a 404
 * vs "ingest down" on a 502) — only a thrown/unreachable hop becomes 502 (the monitor
 * proxy collapses to 502; this intentionally does not).
 */
export async function proxyJson(path: string, init: Init = {}): Promise<NextResponse> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: { ...(await adminHeaders()), ...(init.contentType ? { "content-type": init.contentType } : {}) },
      body: init.body ?? null,
      cache: "no-store",
    });
    const text = await res.text(); // ingest always replies JSON; pass through verbatim
    if (!res.ok) {
      return new NextResponse(text || JSON.stringify({ error: "ingest error", status: res.status }), {
        status: res.status, // forward 400/401/404 so the UI can react (404 → "not found")
        headers: { "content-type": "application/json" },
      });
    }
    return new NextResponse(text, { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
}

/**
 * Proxy a streaming file download (for 12.2b exports), forwarding content-disposition +
 * x-export-* headers. `signal` ties the upstream hop to the browser connection so a client
 * disconnect cancels the Next→ingest fetch too (no leaked upstream stream — the M9 leak
 * discipline). Defined now so the foundation is complete in one place.
 */
export async function proxyStream(path: string, signal: AbortSignal): Promise<Response> {
  const reqHeaders = await adminHeaders();
  let upstream: Response;
  try {
    upstream = await fetch(`${ingestUrl()}${path}`, { headers: reqHeaders, cache: "no-store", signal });
  } catch {
    return new Response("ingest unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new Response("ingest error", { status: upstream.status || 502 });
  const headers = new Headers({ "cache-control": "no-store" });
  for (const h of [
    "content-type",
    "content-disposition",
    "x-export-row-count",
    "x-export-truncated",
    "x-export-redaction-version",
  ]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: 200, headers });
}
