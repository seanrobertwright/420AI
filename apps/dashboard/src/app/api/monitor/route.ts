import { NextResponse } from "next/server";
import { ingestUrl, adminHeaders } from "@/lib/ingest";

/**
 * Snapshot JSON proxy (M9, D8). The browser fetches this same-origin route (no auth
 * header); the Next server adds the admin bearer on the server→ingest hop. `force-dynamic`
 * so it is never statically prerendered; a refused upstream THROWS (it does not return
 * `!res.ok`), so the fetch is wrapped in try/catch → a clean 502 (spike gotcha #5).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${ingestUrl()}/v1/monitor`, {
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
