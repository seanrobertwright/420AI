/**
 * M15 15.10 — WHICH PATHS THE SESSION GATE LETS THROUGH, as a pure function so it can be tested
 * without constructing a `NextRequest` or booting the Edge runtime.
 *
 * It lives here rather than inline in `middleware.ts` for exactly one reason: this predicate is the
 * highest-risk line in the slice and it had to be pinned by a unit test. A `middleware.ts` that only
 * exports `middleware`/`config` is the shape Next expects, and driving it in a test means faking a
 * request — so the decision moved out and the middleware calls it.
 *
 * Keep it `subtle`-free and dependency-free: it is imported into the EDGE middleware graph, where a
 * stray `node:crypto` import breaks `next build` (see `lib/session.ts`).
 */

/**
 * Paths matched by EXACT EQUALITY.
 *
 * `/login/mfa` is listed separately and NOT covered by `/login`, which is the whole point of the
 * exact match: it is the second half of a login, so by construction the visitor has no session yet,
 * and omitting it made the second step redirect to `/login?next=/login/mfa` forever — reading as
 * "the password form is broken".
 */
export const PUBLIC_PATHS = ["/login", "/login/mfa"] as const;

/**
 * Paths matched by PREFIX, for surfaces whose path carries a parameter.
 *
 * `/invite/<token>` is M15's one emailed link and can never EQUAL a static entry, so the exact-match
 * array cannot cover it. Without this, every invited colleague is bounced to
 * `/login?next=/invite/<token>` — a login page they have no account for, with their one-time token
 * in the query string of a URL they cannot use. That failure looks exactly like a backend bug.
 *
 * The trailing slash is load-bearing: `/invite` (no token) and `/invitex` must both stay GATED. A
 * bare `/invite` prefix would make any future `/invitex-admin` route public by accident.
 *
 * `/login` deliberately does NOT get a prefix entry — that would publish any future nested login
 * route the day it is added, unreviewed. A prefix is a standing grant; add them one surface at a
 * time.
 */
// `as const` on BOTH: these two arrays are the session gate's allow-list, and as mutable
// `string[]` any importer could `PUBLIC_PREFIXES.push("/")` and open every route in the app
// with the compiler raising nothing. The unit test pins the CONTENTS; only the type can pin
// that nothing appends to them at runtime.
export const PUBLIC_PREFIXES = ["/invite/"] as const;

/** True when `pathname` needs no session. The API-auth prefix is handled by the caller. */
export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.some((p) => pathname === p) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  );
}
