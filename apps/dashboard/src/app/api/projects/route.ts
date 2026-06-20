import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * Projects collection proxy. GET `/v1/projects` → `{ projects: ProjectRow[] }` (12.2a).
 * POST `/v1/projects {name,gitRemote?}` → `{id}` (12.2b create). The browser's JSON body is
 * forwarded verbatim; the admin bearer is added on the server→ingest hop (D8).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/projects");
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/projects", { method: "POST", body, contentType: "application/json" });
}
