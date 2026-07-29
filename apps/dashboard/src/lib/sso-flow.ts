/**
 * M15 15.7 — the short-lived per-flow state the SSO round trip carries in ONE httpOnly cookie.
 *
 * Shared by the `start` and `callback` route handlers so the cookie's name, lifetime and shape
 * have exactly one definition. It is deliberately NOT server state: ingest allocates nothing per
 * click, so an unauthenticated endpoint cannot be used to amplify writes.
 */
export const SSO_FLOW_COOKIE = "ai_sso";

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
