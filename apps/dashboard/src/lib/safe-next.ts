/**
 * M15 15.7 — THE same-origin redirect guard, extracted from `login-form.tsx` so the SSO callback
 * and the login form share ONE definition (D-15.7-6's sibling concern).
 *
 * `next` arrives from a query string and is used in a redirect, so a naive `startsWith("/")` is an
 * open redirect: `//evil.com` is protocol-relative and `/\evil.com` is normalised to the same
 * thing by browsers. Both pass the naive check and both leave the origin. The SSO callback is the
 * more dangerous of the two call sites — it redirects a user who has JUST authenticated, so an
 * off-site bounce carries maximum trust.
 */
export const DEFAULT_NEXT = "/monitor";

export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : DEFAULT_NEXT;
}
