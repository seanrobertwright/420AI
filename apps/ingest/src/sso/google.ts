import type { SsoProfile, SsoProvider, SsoProviderConfig } from "./provider.js";
import { SsoProviderError } from "./provider.js";

/**
 * Google OpenID Connect client (M15 15.7). Endpoints read from the live discovery document
 * https://accounts.google.com/.well-known/openid-configuration during planning, not from memory.
 *
 * WE DO NOT VERIFY THE `id_token` SIGNATURE, AND THAT IS DELIBERATE (D-15.7-2). Signature
 * validation exists for an ID token that arrived through an UNTRUSTED channel (the browser, in the
 * implicit/hybrid flows). Here the token was fetched by THIS process over TLS directly from
 * Google's token endpoint, authenticated with our client secret — OIDC Core §3.1.3.7 explicitly
 * permits skipping validation in exactly that case. So instead of pulling in a JWT library and a
 * JWKS cache (a dependency and a moving part, both of which can be got wrong), we spend one extra
 * round trip on `userinfo`, which is authoritative and makes Google and GitHub the SAME SHAPE:
 * exchange code → get access token → call a profile endpoint.
 */
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
/** `openid email` is all this slice consumes; `profile` is NOT requested — we store no name. */
const SCOPE = "openid email";

interface GoogleTokenResponse {
  access_token?: string;
}
interface GoogleUserinfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

/** Pure: raw userinfo → our profile. Exported so the mapping is unit-testable without network. */
export function toGoogleProfile(raw: GoogleUserinfo): SsoProfile {
  if (!raw.sub) throw new SsoProviderError("google userinfo returned no subject");
  return {
    subject: raw.sub,
    email: raw.email ?? null,
    // `=== true`, not truthiness: Google returns a real boolean, and coercing a missing claim to
    // "verified" is the one mistake in this file that would be a security bug rather than a bug.
    emailVerified: raw.email_verified === true,
  };
}

/**
 * Exchange the authorization code for an access token. FORM-ENCODED, not JSON — sending JSON
 * returns a 400 whose body says `invalid_request` with no hint about the content type.
 */
async function postForToken(
  cfg: SsoProviderConfig,
  params: { code: string; codeVerifier?: string; redirectUri: string },
): Promise<string> {
  let json: GoogleTokenResponse;
  try {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
      ...(params.codeVerifier ? { code_verifier: params.codeVerifier } : {}),
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      // The body may carry Google's `error_description`, but it can also echo the code back; the
      // status alone is what the operator needs and nothing here can leak a credential.
      throw new SsoProviderError(`google token endpoint returned ${res.status}`);
    }
    json = (await res.json()) as GoogleTokenResponse;
  } catch (err) {
    if (err instanceof SsoProviderError) throw err;
    // fetch reject, AbortSignal.timeout, or JSON parse failure.
    throw new SsoProviderError(
      `google token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!json.access_token) throw new SsoProviderError("google token endpoint returned no token");
  return json.access_token;
}

async function getUserinfo(cfg: SsoProviderConfig, accessToken: string): Promise<GoogleUserinfo> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      throw new SsoProviderError(`google userinfo returned ${res.status}`);
    }
    const body: unknown = await res.json();
    // Shape-check INSIDE the try, because the dereference happens outside it. `toGoogleProfile`
    // reads `raw.sub` in `exchange`, so a 200 carrying `null` (an interposing proxy, an edge error
    // page that happens to be valid JSON) would throw a raw TypeError there — and app.ts maps only
    // `SsoProviderError`, so it would surface as an opaque 500, contradicting this file's own
    // "never a leaked 500" contract. The emails array in github.ts was already guarded; this is
    // the object case that was missed.
    if (typeof body !== "object" || body === null) {
      throw new SsoProviderError("google userinfo returned a non-object body");
    }
    return body as GoogleUserinfo;
  } catch (err) {
    if (err instanceof SsoProviderError) throw err;
    throw new SsoProviderError(
      `google userinfo request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function googleProvider(cfg: SsoProviderConfig): SsoProvider {
  return {
    usesPkce: true,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        state,
        // No `access_type=offline` and no `prompt=consent`: we want NO refresh token (D-15.7-5 —
        // we never call Google again after the login), and asking for one triggers a consent
        // screen the user has no reason to see.
        ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
      });
      return `${AUTHORIZE_URL}?${q.toString()}`;
    },
    async exchange({ code, codeVerifier, redirectUri }) {
      const accessToken = await postForToken(cfg, { code, codeVerifier, redirectUri });
      return toGoogleProfile(await getUserinfo(cfg, accessToken));
    },
  };
}
