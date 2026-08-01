import { proxyJson } from "@/lib/proxy";

/**
 * M15 15.8 — the caller's own second-factor status, for the Settings card.
 *
 * Session-gated at ingest; `proxyJson` attaches the session bearer on the server→ingest hop so the
 * token stays httpOnly and the browser never holds a credential (D8).
 *
 * ONE ROUTE FILE PER INGEST ENDPOINT, mirroring the paths 1:1 (`enroll`, `enroll/confirm`, `disable`,
 * `recovery-codes`, `verify`). The alternative — one handler dispatching on an `action` field — would
 * put the choice of which credential operation runs inside a request body, which is both harder to
 * read and one refactor away from an operation reachable by a value nobody validated.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/auth/mfa");
}
