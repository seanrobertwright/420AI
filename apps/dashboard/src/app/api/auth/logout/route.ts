import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { proxyJson } from "@/lib/proxy";

/**
 * M12 12.3 logout. Clears the httpOnly session cookie; the next navigation hits the middleware
 * gate with no session → redirect to /login. POST (a mutation) so a prefetch can't log the admin out.
 *
 * M15 15.6 (D-M15-12) — it now also ENDS THE SESSION SERVER-SIDE. Clearing the cookie alone only
 * ever made the BROWSER forget a credential that stayed valid for the rest of its seven days;
 * OWASP's Session Management guidance is explicit that the identifier must be invalidated on the
 * server. The ingest hop runs FIRST, while the cookie is still readable — `adminHeaders()` sources
 * the bearer from it, so clearing first would leave nothing to authenticate the revoke with.
 *
 * D-15.6-4 RESIDUAL, named rather than hidden: `middleware.ts` verifies this cookie's MAC on the
 * EDGE runtime with no database access, so it cannot see revocation. If a session is revoked from
 * somewhere else, this browser's cookie keeps rendering the dashboard SHELL until its `exp` passes
 * (up to 7 days) while every data fetch through it 401s from ingest. That is deliberate: the
 * security boundary is ingest, and closing the gap would put a network hop on every navigation for
 * no security gain. Documented in `docs/guide/operations.md`.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  // Best-effort: the ingest hop's outcome is deliberately IGNORED. A logout that leaves the user
  // logged in because the archive is unreachable is a worse outcome than a session row that
  // outlives its cookie — the row expires on its own within 7 days, whereas a browser that refuses
  // to sign out has no recovery at all.
  //
  // The `try` is defence against `proxyJson`'s CONTRACT changing, not against a throw that is
  // reachable today — and being precise about that matters, because the first version of this
  // comment named `adminHeaders()`'s `await cookies()` as the escape route and that is provably
  // wrong: `proxyJson` evaluates it INSIDE its own `try` and collapses every failure, that one
  // included, into a 502 *response*. (Its sibling `proxyStream` is the one that calls
  // `adminHeaders()` outside the try — the claim was imported from the wrong function.)
  //
  // So nothing here can throw right now. The `try` stays anyway, because the guarantee this
  // handler owes is "the cookie is always cleared", and "a helper happens to catch the failure I
  // thought of" is a weaker promise that a future edit inside `proxyJson` could silently withdraw.
  try {
    await proxyJson("/v1/auth/logout", { method: "POST" });
  } catch {
    // Swallowed on purpose: nothing this route could report would change what the user needs, and
    // the session row expires on its own. Not logged — a Route Handler has no logger wired here.
  }
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
