import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.10 — the ADMIN MFA RESET that 15.8 designed and refused to ship without 15.5's rank floor
 * and an audit record. DELETE `/v1/members/:userId/mfa` → 204; it clears the target's second factor
 * AND revokes their sessions in one transaction, so the reset does not leave a pre-existing session
 * alive with the second factor removed.
 */
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return proxyJson(`/v1/members/${userId}/mfa`, { method: "DELETE" });
}
