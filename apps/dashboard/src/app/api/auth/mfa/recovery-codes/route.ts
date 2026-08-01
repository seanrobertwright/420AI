import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.8 — replace the recovery-code set, returning the new one ONCE. Requires a live code for the
 * same reason `disable` does (D-15.8-12): a stolen session must not be able to mint itself a set of
 * long-lived bypass credentials. The old set stops working the moment this returns 200.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyJson("/v1/auth/mfa/recovery-codes", {
    method: "POST",
    body: await req.text(),
    contentType: "application/json",
  });
}
