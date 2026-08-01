import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.8 — phase TWO: prove the authenticator agrees, arm the credential, and return the ten
 * recovery codes.
 *
 * THIS IS THE ONLY RESPONSE THAT EVER CARRIES THE RECOVERY CODES. They are stored as sha256
 * (D-15.8-7), so no endpoint can show them again; the card must present them as a save-once block.
 *
 * The body is forwarded VERBATIM (`req.text()`) rather than parsed and re-serialised: ingest's ajv
 * schema is the validator, and a second, looser one here would be a place for the two to disagree.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyJson("/v1/auth/mfa/enroll/confirm", {
    method: "POST",
    body: await req.text(),
    contentType: "application/json",
  });
}
