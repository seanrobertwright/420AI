/**
 * M15 15.7 — THE same-origin redirect guard, extracted from `login-form.tsx` so the SSO callback
 * and the login form share ONE definition (D-15.7-6's sibling concern).
 *
 * `next` arrives from a query string and is used in a redirect, so a naive `startsWith("/")` is an
 * open redirect: `//evil.com` is protocol-relative and `/\evil.com` is normalised to the same
 * thing by browsers. The SSO callback is the more dangerous of the two call sites — it redirects a
 * user who has JUST authenticated, so an off-site bounce carries maximum trust.
 */
export const DEFAULT_NEXT = "/monitor";

/**
 * THE PREFIX CHECKS ARE NOT ENOUGH ON THEIR OWN, and the reason is that the URL parser and this
 * function do not see the same string.
 *
 * WHATWG URL parsing **strips** tab (U+0009), LF (U+000A) and CR (U+000D) from anywhere in the
 * input — AFTER any inspection done here. So a value beginning slash-tab-slash passes all three
 * prefix guards (it starts with `/`, and character 1 is a tab rather than a second `/`), and
 * `new URL(...)` then resolves it to `https://evil.com/`. Measured, not theorised:
 *
 *     "/reports"           -> guard passes -> host app.test    OK
 *     "//evil.com"         -> guard REJECTS                    OK
 *     slash-TAB-slash-host -> guard passed -> host EVIL.COM    BUG (likewise LF and CR)
 *
 * That is a full off-origin redirect at the exact moment the user has just authenticated and the
 * session cookie has just been set — the highest-trust moment there is, and therefore an excellent
 * phishing primitive ("your session expired, sign in again"). The `next` value reaches here from a
 * query string on an unauthenticated GET, so it is fully attacker-supplied.
 *
 * The fix rejects the characters the parser removes rather than trying to out-guess it. It is
 * written as an explicit CHARACTER-CODE scan rather than a regex, deliberately: expressing this
 * class as a regex requires control-character escapes in the source, and getting one wrong is
 * silent — an over-broad range like `[<space>-\\]` also matches `/` (U+002F) and would send every
 * redirect to the default, while embedding the raw characters puts a NUL byte in a source file.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return DEFAULT_NEXT;
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    // C0 controls (includes tab/LF/CR), DEL, and backslash — the last because browsers normalise
    // it to `/`, which makes a leading `/\` protocol-relative by another route.
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return DEFAULT_NEXT;
  }
  return next.startsWith("/") && !next.startsWith("//") ? next : DEFAULT_NEXT;
}
