"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * M15 15.7 — the link/unlink surface, a client island inside the existing Settings page (no new
 * route). Without it, the anti-takeover policy's escape hatch is curl-only: every account that
 * already exists is refused at the SSO login (409 `link_required`) and can ONLY become
 * SSO-capable by connecting the provider here, from an already-authenticated session.
 *
 * Both hops go through same-origin proxy route handlers, so the session token stays httpOnly and
 * the browser never holds a credential (D8).
 */

const LABELS: Record<string, string> = { google: "Google", github: "GitHub" };

interface SsoIdentity {
  id: string;
  provider: string;
  email: string | null;
  createdAt: string;
}

export function SsoLinks() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [available, setAvailable] = useState<string[]>([]);
  const [linked, setLinked] = useState<SsoIdentity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(() => {
    const e = searchParams.get("ssoError");
    if (e === "identity_taken")
      return "That provider account is already linked to another 420AI user.";
    return e ? "Connecting the provider failed. Please try again." : null;
  });

  const load = useCallback(async () => {
    const [p, i] = await Promise.all([
      fetch("/api/auth/sso/providers")
        .then((r) => (r.ok ? r.json() : { providers: [] }))
        .catch(() => ({ providers: [] as string[] })),
      fetch("/api/auth/sso/identities")
        .then((r) => (r.ok ? r.json() : { identities: [] }))
        .catch(() => ({ identities: [] as SsoIdentity[] })),
    ]);
    return {
      providers: (p.providers ?? []) as string[],
      identities: (i.identities ?? []) as SsoIdentity[],
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then(({ providers, identities }) => {
      if (cancelled) return;
      setAvailable(providers);
      setLinked(identities);
    });
    // Armed before the first await resolves, so a navigation mid-fetch cannot setState on an
    // unmounted island.
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function disconnect(provider: string): Promise<void> {
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch(`/api/auth/sso/${provider}`, { method: "DELETE" });
      if (res.status === 409) {
        // The last-credential refusal. Say what to DO about it — an SSO-created account has no
        // password, so "set one first" is the whole remedy.
        setError("Set a password before disconnecting your only sign-in method.");
        return;
      }
      if (!res.ok && res.status !== 404) {
        setError("Disconnecting failed. Please try again.");
        return;
      }
      const { identities } = await load();
      setLinked(identities);
      router.refresh();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  if (available.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Single sign-on</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {available.map((id) => {
          const link = linked?.find((l) => l.provider === id);
          return (
            <div key={id} className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">{LABELS[id] ?? id}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {link
                    ? `${link.email ?? "connected"} · since ${formatDate(link.createdAt)}`
                    : "Not connected"}
                </p>
              </div>
              {link ? (
                <button
                  type="button"
                  onClick={() => void disconnect(id)}
                  disabled={busy === id}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    "border-border hover:bg-muted disabled:opacity-50",
                  )}
                >
                  {busy === id ? "Disconnecting…" : "Disconnect"}
                </button>
              ) : (
                // An ANCHOR, like the login buttons: a top-level navigation to the provider.
                <a
                  href={`/api/auth/sso/${id}/start?mode=link&next=%2Fsettings`}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    "border-border hover:bg-muted",
                  )}
                >
                  Connect
                </a>
              )}
            </div>
          );
        })}
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
