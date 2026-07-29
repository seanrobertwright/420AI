import { googleProvider } from "./google.js";
import { githubProvider } from "./github.js";

/**
 * The SSO Provider abstraction (M15 15.7, D-M15-5). An INJECTED, configurable set of providers,
 * wired through `BuildAppOptions` exactly as `analysisProvider` / `mailer` / `alertDeliverer` are
 * (the proven buildApp pattern) — so EVERY automated test drives a deterministic stub and the
 * live `fetch` runs only in `server.ts` and manual validation. Without this an OAuth slice is
 * simply untestable.
 *
 * Silent library (CLAUDE.md): the clients throw `SsoProviderError`, never log.
 * No SDK and no JWT dependency — plain `fetch` + `AbortSignal.timeout`, like `analysis/*`.
 */

/** What a provider tells us about a person. The ONLY three facts this slice consumes. */
export interface SsoProfile {
  /** The provider's IMMUTABLE user id — Google `sub`, GitHub numeric `id`. NEVER a username. */
  subject: string;
  /** The address the provider asserts. Display/audit only; never a lookup key (D-15.7-1). */
  email: string | null;
  /** Whether the PROVIDER has verified that address. Branch 2 of the policy turns on this. */
  emailVerified: boolean;
}

export interface SsoProvider {
  /** True when the provider documents PKCE support (Google yes, GitHub no — see github.ts). */
  readonly usesPkce: boolean;
  /** Build the provider's authorize URL. Pure — unit-tested without network. */
  authorizeUrl(params: { state: string; codeChallenge?: string; redirectUri: string }): string;
  /** Exchange `code` for a profile. The one method that talks to the network. */
  exchange(params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
  }): Promise<SsoProfile>;
}

/**
 * A clean, mappable failure for ANY provider problem. `unavailable` → 502 and `not_configured`
 * → 503 via app.ts, so a provider outage is never a leaked 500. Deliberately does NOT carry the
 * POLICY reasons (`link_required`, `signup_disabled`, …) — those are decisions the route makes
 * about our own data and it returns them as explicit status codes, the way signup returns its 409.
 */
export class SsoProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "not_configured" = "unavailable",
  ) {
    super(message);
    this.name = "SsoProviderError";
  }
}

export interface SsoProviderConfig {
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}

export interface SsoConfig {
  google?: SsoProviderConfig;
  github?: SsoProviderConfig;
}

export type SsoProviders = Partial<Record<"google" | "github", SsoProvider>>;

export const SSO_PROVIDER_IDS = ["google", "github"] as const;
export type SsoProviderId = (typeof SSO_PROVIDER_IDS)[number];

export function isSsoProviderId(s: string): s is SsoProviderId {
  return (SSO_PROVIDER_IDS as readonly string[]).includes(s);
}

/**
 * Build the configured providers. An UNCONFIGURED provider is simply ABSENT from the map rather
 * than present-and-throwing, which is the one deliberate divergence from `createAnalysisProvider`'s
 * `notConfigured()` stand-in: the login page asks `GET /v1/auth/sso/providers` which buttons to
 * render, and "present but always fails" would render a button that cannot work.
 */
export function createSsoProviders(cfg: SsoConfig): SsoProviders {
  const out: SsoProviders = {};
  if (cfg.google) out.google = googleProvider(cfg.google);
  if (cfg.github) out.github = githubProvider(cfg.github);
  return out;
}
