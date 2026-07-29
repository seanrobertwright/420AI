import type { SsoProfile, SsoProvider, SsoProviderConfig } from "./provider.js";
import { SsoProviderError } from "./provider.js";

/**
 * GitHub OAuth client (M15 15.7). THREE differences from Google, all of them load-bearing:
 *
 *  1. NO `id_token` and no OIDC at all — the profile comes from `GET /user`.
 *  2. The verified flag is NOT on `/user`. `/user.email` is the account's PUBLIC address and
 *     carries no verification signal; the truth lives in `GET /user/emails`, whose elements are
 *     `{email, primary, verified, visibility}`. We take the entry that is BOTH `primary` AND
 *     `verified` — primary-but-unverified must not pass, and verified-but-secondary is not the
 *     address the person identifies by.
 *  3. `usesPkce: false`. GitHub's OAuth-App documentation specifies `state` and does not document
 *     PKCE, so we do not send a challenge we cannot rely on being enforced. `state` remains
 *     mandatory. If GitHub documents PKCE later this becomes a one-line change.
 *
 * The subject is `String(user.id)` — the NUMERIC id, never `login`. A GitHub username can be
 * changed and a released one re-registered by somebody else, so keying on it would let a stranger
 * inherit an account by claiming a handle (D-15.7-1).
 */
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";
/**
 * `user:email` is required to read /user/emails; `read:user` for /user. NO `repo` scope —
 * this is identity only (D-M15-5 supersedes 12.3's rejection on identity grounds, not API ones).
 */
const SCOPE = "read:user user:email";
const API_VERSION = "2026-03-10";

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}
export interface GithubUser {
  id?: number | string;
}
export interface GithubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

/** Pure: raw `/user` + `/user/emails` → our profile. Exported for unit tests (no network). */
export function toGithubProfile(user: GithubUser, emails: GithubEmail[]): SsoProfile {
  if (user.id === undefined || user.id === null || user.id === "") {
    throw new SsoProviderError("github /user returned no id");
  }
  // `String(...)` at the boundary: `id` is a NUMBER in GitHub's JSON, and a numeric subject would
  // be inserted into a `text` column by drizzle without complaint on one path while being compared
  // as a string on another.
  const subject = String(user.id);
  const primary = emails.find((e) => e.primary === true);
  // BOTH flags on the SAME entry, and only the primary one is considered — a verified SECONDARY
  // address is not the address the person identifies by, and treating it as one would let somebody
  // present an address their account merely happens to own.
  const verifiedPrimary = primary?.verified === true ? primary : undefined;
  return {
    subject,
    email: verifiedPrimary?.email ?? primary?.email ?? null,
    emailVerified: verifiedPrimary !== undefined && Boolean(verifiedPrimary.email),
  };
}

async function postForToken(
  cfg: SsoProviderConfig,
  params: { code: string; redirectUri: string },
): Promise<string> {
  let json: GithubTokenResponse;
  try {
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        // WITHOUT THIS GitHub replies form-encoded and `res.json()` throws. It is the single most
        // commonly missed header in a GitHub OAuth integration.
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      throw new SsoProviderError(`github token endpoint returned ${res.status}`);
    }
    json = (await res.json()) as GithubTokenResponse;
  } catch (err) {
    if (err instanceof SsoProviderError) throw err;
    throw new SsoProviderError(
      `github token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // GitHub answers **200 with an `{error, error_description}` body** for a bad code rather than a
  // 4xx. Without this branch an invalid code becomes "undefined access token" much later and much
  // more confusingly.
  if (json.error) {
    throw new SsoProviderError(`github token endpoint returned error: ${json.error}`);
  }
  if (!json.access_token) throw new SsoProviderError("github token endpoint returned no token");
  return json.access_token;
}

async function getJson<T>(cfg: SsoProviderConfig, url: string, accessToken: string): Promise<T> {
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        // GitHub's API rejects requests with no user agent.
        "user-agent": "420ai-ingest",
      },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      throw new SsoProviderError(`github api ${url} returned ${res.status}`);
    }
    const body: unknown = await res.json();
    // See the matching guard in google.ts: the dereference (`user.id`) happens in `exchange`,
    // OUTSIDE this try, so a 200 with a `null` body would escape as a raw TypeError and be masked
    // as a 500 rather than mapped to a 502.
    if (typeof body !== "object" || body === null) {
      throw new SsoProviderError(`github api ${url} returned a non-object body`);
    }
    return body as T;
  } catch (err) {
    if (err instanceof SsoProviderError) throw err;
    throw new SsoProviderError(
      `github api request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function githubProvider(cfg: SsoProviderConfig): SsoProvider {
  return {
    usesPkce: false,
    authorizeUrl({ state, redirectUri }) {
      // NOTE the absence of `code_challenge`: see difference 3 in the file header. `state` is
      // still mandatory and is what GitHub's own guidance prescribes.
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        scope: SCOPE,
        state,
      });
      return `${AUTHORIZE_URL}?${q.toString()}`;
    },
    async exchange({ code, redirectUri }) {
      const accessToken = await postForToken(cfg, { code, redirectUri });
      const user = await getJson<GithubUser>(cfg, USER_URL, accessToken);
      const emails = await getJson<GithubEmail[]>(cfg, EMAILS_URL, accessToken);
      return toGithubProfile(user, Array.isArray(emails) ? emails : []);
    },
  };
}
