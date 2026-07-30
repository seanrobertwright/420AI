import type { NextRequest } from "next/server";
import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.8 — phase ONE of enrolment: mint an unconfirmed secret and hand it back for manual entry.
 *
 * The response carries the shared secret, which is correct rather than a leak: this hop is
 * session-gated and the secret is exactly what the caller must transcribe into their authenticator.
 * It is never readable again — `GET /api/auth/mfa` reports status only. A 409 here means a CONFIRMED
 * credential already exists (D-15.8-10); the UI must offer "disable first", not silently re-enrol.
 *
 * D-15.8-16 — the body now carries `currentPassword` for a password-bearing account, so a stolen
 * session cookie cannot arm a second factor and lock the real owner out. Forwarded VERBATIM: ingest's
 * ajv schema is the validator, and the password/session-recency branch depends on a database row this
 * hop cannot see. A 401 here is `password_required` or `reauth_required`, not an expired session.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyJson("/v1/auth/mfa/enroll", {
    method: "POST",
    body: await req.text(),
    contentType: "application/json",
  });
}
