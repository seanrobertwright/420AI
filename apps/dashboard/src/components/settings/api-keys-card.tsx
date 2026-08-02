"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * M15 15.10 — API KEY self-service, a client island inside the existing Settings page beside
 * `<SsoLinks/>` and `<MfaCard/>`.
 *
 * Until this shipped, 15.9's whole credential tier was curl-only — and the desktop app literally
 * told users "API key not configured. There is no management UI yet (15.10)". This is that UI.
 *
 * TWO THINGS THIS CARD HAS TO GET RIGHT, both borrowed from `mfa-card.tsx`:
 *
 *   1. THE MINTED PLAINTEXT EXISTS EXACTLY ONCE. `GET /v1/auth/api-keys` deliberately omits it and
 *      no column holds it (only a sha256 is stored), so this island's state is the one and only
 *      chance to copy it. It is held in memory, shown with a copy affordance, never re-fetched, and
 *      the UI says so — the same contract the recovery-codes block makes.
 *   2. THE RE-AUTH BRANCH IS SERVER-REPORTED, NOT GUESSED. Minting is gated by `requireRecentAuth`,
 *      which answers 401 with a `reason` discriminant: `password_required` ⇒ reveal a password field
 *      and retry; `reauth_required` ⇒ the account is SSO-only and has no password to offer, so the
 *      only remedy is signing in again. Guessing which applies would mean showing a password field
 *      to a user who does not have one.
 *
 * The password is held only for the duration of the request and cleared in a `finally` — a password
 * lingering in island state is one stray re-render away from being somewhere it should not be.
 *
 * NO `router.refresh()` ANYWHERE IN THIS FILE, deliberately. This island owns its own data — it
 * fetches `/api/auth/api-keys` itself and `settings/page.tsx` passes it nothing — so refreshing the
 * server component could not change a single rendered value here. It is not free either: the
 * Settings page's server pass re-fetches `/v1/monitor`, and per CLAUDE.md's 15.4 lesson that GET
 * performs an alert-firing RECONCILE (a read that writes). Contrast `team/team-view.tsx`, where
 * `router.refresh()` IS load-bearing because the PageShell subtitle comes from a server fetch.
 */

interface ApiKey {
  id: string;
  name: string;
  role: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  /** Revealed only after the server says `password_required` — see the header. */
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const [password, setPassword] = useState("");
  /** The plaintext, in memory only, until dismissed. There is no endpoint that could re-fetch it. */
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (): Promise<ApiKey[] | null> => {
    return fetch("/api/auth/api-keys")
      .then((r) => (r.ok ? (r.json() as Promise<{ apiKeys: ApiKey[] }>) : null))
      .then((d) => d?.apiKeys ?? null)
      .catch(() => null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((k) => {
      if (!cancelled) setKeys(k);
    });
    // Armed before the first await resolves, so a navigation mid-fetch cannot setState on an
    // unmounted island.
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function mint(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy("mint");
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/auth/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          // Omitted entirely when empty — the upstream schema is `additionalProperties: false` and
          // treats an ABSENT password as "SSO-only, prove recency instead", which an empty string
          // would not.
          ...(password ? { currentPassword: password } : {}),
        }),
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string };
        if (body.reason === "password_required") {
          setPasswordNeeded(true);
          setError("Confirm your password to create an API key.");
        } else {
          // `reauth_required` — an SSO-only account has no password to present.
          setError("Sign in again before creating an API key.");
        }
        return;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
        setError(body.error ?? "That key could not be created.");
        return;
      }
      if (!res.ok) {
        setError("Could not create the key. Please try again.");
        return;
      }
      const body = (await res.json()) as { apiKey: ApiKey; token: string };
      setMinted({ name: body.apiKey.name, token: body.token });
      setName("");
      setPasswordNeeded(false);
      // NEVER write a failed reload into `keys`. `load()` returns null on any non-ok/throw, and
      // `keys === null` renders "No API keys." — so a blip on the follow-up GET would tell the user
      // they hold none, immediately after the green block showed them one they just minted.
      // `team-view.tsx`'s `if (m) setRoster(m)` guards the same way.
      const after = await load();
      if (after) setKeys(after);
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
      // Never outlives the request that used it.
      setPassword("");
    }
  }

  /**
   * `copied` IS ONLY EVER SET AFTER A RESOLVED WRITE, and that is the whole point of this shape.
   *
   * `navigator.clipboard` is UNDEFINED outside a secure context — `localhost` counts as secure, so
   * anything that works in dev and in every test can still fail on a self-hosted box reached at
   * `http://192.168.x.x:3000`, which is this product's actual deployment shape.
   *
   * An optional call (`navigator.clipboard?.writeText(...)`) is NOT the fix, and is in fact worse
   * than no guard: it resolves to `undefined` without throwing, so the `catch` never runs and the
   * button flips to "Copied" having copied nothing. The user then presses Dismiss and the minted
   * plaintext — which exists exactly once and is never re-fetchable — is gone. So the absence is
   * detected EXPLICITLY and reported, and the write is awaited before claiming success.
   *
   * Both failure paths tell the user the one thing that still works: the token is rendered above,
   * so manual selection is a real fallback. (`pairing/pairing-view.tsx` catches a rejection the
   * same way, but its value can be re-fetched — this one cannot, so it also needs the copy.)
   */
  async function copyToken(): Promise<void> {
    if (!minted) return;
    if (!navigator.clipboard) {
      setError("Copying is unavailable here — select the token above and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      setError("Copy was blocked — select the token above and copy it manually.");
    }
  }

  async function revoke(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-keys/${id}`, { method: "DELETE" });
      // 404 covers "unknown", "already revoked" and "not yours" upstream, deliberately — so it is
      // treated as success here rather than reported as an error the user cannot act on.
      if (!res.ok && res.status !== 404) {
        setError("Could not revoke that key.");
        return;
      }
      const after = await load();
      if (after) setKeys(after);
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll(): Promise<void> {
    setBusy("all");
    setError(null);
    try {
      const res = await fetch("/api/auth/api-keys", { method: "DELETE" });
      if (!res.ok) {
        setError("Could not revoke your keys.");
        return;
      }
      const after = await load();
      if (after) setKeys(after);
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">API keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-xs">
          Named, revocable credentials for machine clients — the desktop app, a cron host, a CI
          runner. A key never grants more than your own role.
        </p>

        {minted ? (
          <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
            <p className="text-xs font-medium">
              Copy “{minted.name}” now — this is the only time it will ever be shown.
            </p>
            <code className="block break-all font-mono text-xs">{minted.token}</code>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copyToken()}
                className="border-border hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium"
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMinted(null);
                  setCopied(false);
                }}
                className="border-border hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        <form onSubmit={(e) => void mint(e)} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="key-name" className="text-muted-foreground text-xs font-medium">
              Name
            </label>
            <input
              id="key-name"
              type="text"
              required
              placeholder="laptop"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border-border bg-background rounded-md border px-3 py-1.5 text-sm"
            />
          </div>
          {passwordNeeded ? (
            <div className="space-y-1">
              <label htmlFor="key-password" className="text-muted-foreground text-xs font-medium">
                Current password
              </label>
              <input
                id="key-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="border-border bg-background rounded-md border px-3 py-1.5 text-sm"
              />
            </div>
          ) : null}
          <button
            type="submit"
            disabled={busy === "mint"}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {busy === "mint" ? "Creating…" : "Create key"}
          </button>
        </form>

        {keys === null ? null : keys.length > 0 ? (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{k.name}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      `created ${formatDate(k.createdAt)}`,
                      k.role ? `role ${k.role}` : "inherits your role",
                      k.expiresAt ? `expires ${formatDate(k.expiresAt)}` : "never expires",
                      k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt)}` : "never used",
                    ].join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(k.id)}
                  disabled={busy === k.id}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    "border-border hover:bg-muted disabled:opacity-50",
                  )}
                >
                  {busy === k.id ? "Revoking…" : "Revoke"}
                </button>
              </div>
            ))}
            {/* The panic button. Deliberately NOT re-auth gated upstream — revocation must never be
                harder than minting, and a prompt on the "undo" is a prompt mid-incident. */}
            <button
              type="button"
              onClick={() => void revokeAll()}
              disabled={busy === "all"}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                "border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50",
              )}
            >
              {busy === "all" ? "Revoking…" : "Revoke all keys"}
            </button>
          </div>
        ) : (
          // `keys === null` is handled above and renders NOTHING, so this copy is only ever
          // shown for a LOADED, genuinely empty list. Before, a failed load and a first paint both
          // rendered "No API keys." — telling a user who holds live keys that they hold none, and
          // taking the "Revoke all keys" panic button away with them at the worst moment.
          <p className="text-muted-foreground text-xs">No API keys.</p>
        )}

        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
