/**
 * M15 15.7 — the short-lived per-flow state the SSO round trip carries in ONE httpOnly cookie.
 *
 * Shared by the `start` and `callback` route handlers so the cookie's name, lifetime and shape
 * have exactly one definition. It is deliberately NOT server state: ingest allocates nothing per
 * click, so an unauthenticated endpoint cannot be used to amplify writes.
 */
export const SSO_FLOW_COOKIE = "ai_sso";

/**
 * Display labels for the provider ids ingest reports. ONE definition, shared by the login form and
 * the Settings island — both render whatever `GET /v1/auth/sso/providers` returns, so a map that
 * lived in each component would drift the day a third provider is added: the fallback `?? id`
 * silently renders "Sign in with gitlab" on one page and "GitLab" on the other. This is the same
 * "two call sites that must not drift" reason `safe-next.ts` exists.
 */
export const SSO_PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub" };

/**
 * THE COOKIE'S PATH, AND IT MUST BE PASSED TO `delete` AS WELL AS TO `set`.
 *
 * Scoping the cookie to the SSO routes is deliberate — it carries a PKCE verifier and has no
 * business riding along on every request to the app. But browsers key cookies by
 * `(name, domain, path)`, so `cookies().delete("ai_sso")` — which defaults to `Path=/` — does NOT
 * remove a cookie stored at this path. It emits a second, unrelated expired cookie and leaves the
 * real one live for its full `Max-Age`.
 *
 * That shipped once (review finding 1: the callback's own comment promised the cookie was cleared
 * on every path while `Path=/` was going out on the wire, so the verifier and `state` survived
 * every refused attempt for ten minutes). The constant exists so the two call sites cannot drift
 * again, and `callback/route.test.ts` asserts the delete carries it.
 */
export const SSO_FLOW_PATH = "/api/auth/sso";

/** Ten minutes — long enough to read a consent screen, short enough that a stale one expires. */
export const SSO_FLOW_MAX_AGE_SECONDS = 600;

export interface SsoFlowState {
  /** The CSRF value; the callback refuses any mismatch with the provider's echo. */
  state: string;
  /** Present only for a PKCE provider (Google yes, GitHub no). */
  codeVerifier?: string;
  /** `login` mints a session; `link` attaches the identity to an already-authenticated caller. */
  mode: "login" | "link";
  /** Where to land afterwards. Passed through `safeNext` before it is ever used in a redirect. */
  next?: string;
  /** An invitation being accepted through SSO. Ignored in `link` mode by ingest, on purpose. */
  inviteToken?: string;
}

/** Parse the cookie value, returning null for anything malformed. */
export function parseSsoFlow(raw: string | undefined): SsoFlowState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SsoFlowState>;
    if (typeof parsed.state !== "string" || !parsed.state) return null;
    return {
      state: parsed.state,
      codeVerifier: typeof parsed.codeVerifier === "string" ? parsed.codeVerifier : undefined,
      mode: parsed.mode === "link" ? "link" : "login",
      next: typeof parsed.next === "string" ? parsed.next : undefined,
      inviteToken: typeof parsed.inviteToken === "string" ? parsed.inviteToken : undefined,
    };
  } catch {
    return null;
  }
}
