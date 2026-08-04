import type { NextRequest } from "next/server";
import { proxyStream } from "@/lib/proxy";

/**
 * M16 16.2 — the redacted label export download. GET
 * `/v1/labels/export?format=json|jsonl|csv` (+ the same filters as the list).
 *
 * `proxyStream` adds the admin bearer on the server→ingest hop (the token never reaches the
 * browser, D8), forwards `content-disposition` and the `x-export-*` headers, and threads
 * `req.signal` so a cancelled download cancels the upstream fetch too.
 *
 * REDACTED SERVER-SIDE, by `redactJson` in the ingest route (D-16.1-7): `intent` is 200 characters
 * of free human text and `followUpCommitOrPr` is a URL a person pasted, either of which may carry a
 * token or a customer name the author never thought of as leaving the archive. Nothing here needs
 * to re-do that — but nothing here may work around it either.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return proxyStream(`/v1/labels/export${req.nextUrl.search}`, req.signal);
}
