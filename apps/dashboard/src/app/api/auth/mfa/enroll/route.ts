import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.8 — phase ONE of enrolment: mint an unconfirmed secret and hand it back for manual entry.
 *
 * The response carries the shared secret, which is correct rather than a leak: this hop is
 * session-gated and the secret is exactly what the caller must transcribe into their authenticator.
 * It is never readable again — `GET /api/auth/mfa` reports status only. A 409 here means a CONFIRMED
 * credential already exists (D-15.8-10); the UI must offer "disable first", not silently re-enrol.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  return proxyJson("/v1/auth/mfa/enroll", { method: "POST" });
}
