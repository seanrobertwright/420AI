import { NextResponse } from "next/server";
import { ingestUrl, adminHeaders } from "@/lib/ingest";

/**
 * Same-origin alert-firing ack proxy (M10 3c, D8). The browser POSTs here with NO auth
 * header; the Next server adds the admin bearer on the server→ingest hop (the token
 * never reaches the browser). `force-dynamic` so it is never statically prerendered; a
 * refused upstream THROWS, so the fetch is wrapped in try/catch → a clean 502.
 *
 * Next 16 → the `[id]` route's `params` is a Promise and MUST be awaited.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await fetch(`${ingestUrl()}/v1/alerts/firings/${id}/ack`, {
      method: "POST",
      headers: adminHeaders(),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "ingest error", status: res.status }, { status: 502 });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "ingest unreachable" }, { status: 502 });
  }
}
