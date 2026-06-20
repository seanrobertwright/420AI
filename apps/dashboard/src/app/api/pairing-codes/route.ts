import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Mint a short-lived pairing code (M12 12.2b). POST `/v1/pairing-codes {email?}` →
 * `{code,expiresAt}`. Generate-only (there is no list-of-codes endpoint). The browser's JSON
 * body is forwarded verbatim; the admin bearer is added on the server→ingest hop (D8).
 * DEFAULT_EMAIL is applied server-side when `email` is omitted.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/pairing-codes", { method: "POST", body, contentType: "application/json" });
}
