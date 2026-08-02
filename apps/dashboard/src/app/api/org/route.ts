import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — org settings. GET `/v1/org` (`viewer`) → `{id, name, isPersonal, memberCount,
 * yourRole}`; PATCH `/v1/org {name}` (**`owner`** only) → `{org}`.
 *
 * `memberCount` is what the Settings `<OrgCard/>` branches on to satisfy D-M15-10 — a single user
 * never sees an org — and `yourRole` is what `/team` uses to decide which controls to render. The
 * server is still the gate; hiding a button is courtesy, never enforcement.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/org");
}

export async function PATCH(req: NextRequest) {
  const body = await req.text();
  return proxyJson("/v1/org", { method: "PATCH", body, contentType: "application/json" });
}
