import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — change a colleague's rung, or remove them. Both `admin`-gated upstream, and both
 * subject to the 15.5 ceiling-and-floor: a 403 here can mean either "you may not GRANT that rung"
 * or "you may not act on someone who outranks you". The UI renders the shared `FORBIDDEN_MESSAGE`
 * for both rather than guessing which.
 *
 * `params` is a PROMISE in this Next version — `await` it, as every other dynamic proxy here does.
 */
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const body = await req.text();
  return proxyJson(`/v1/members/${userId}`, {
    method: "PATCH",
    body,
    contentType: "application/json",
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return proxyJson(`/v1/members/${userId}`, { method: "DELETE" });
}
