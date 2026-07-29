"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeNext } from "@/lib/safe-next";
import { SSO_PROVIDER_LABELS } from "@/lib/sso-flow";

/**
 * M15 15.7 — the copy for each refusal the SSO callback can bounce back with. `link_required` is
 * the one that matters: it is the slice's CENTRAL behaviour (a pre-existing account is never
 * adopted), and without an explanation here every operator files it as a bug.
 */
const SSO_ERRORS: Record<string, string> = {
  link_required:
    "That address already has a 420AI account. Sign in with your password, then connect the provider from Settings.",
  signup_disabled: "SSO sign-up is disabled here. Ask an administrator for an invitation.",
  email_unverified: "Your provider has not verified that email address.",
  invite_mismatch: "That invitation was issued to a different email address.",
  sso_state: "The sign-in attempt expired or could not be verified. Please try again.",
  sso_denied: "The sign-in was cancelled at the provider.",
  sso_unavailable: "Single sign-on is not available right now.",
  unreachable: "Archive unreachable.",
  // The callback's SESSION_SECRET guard (D.3). It exists to make a misconfiguration LOUD, so
  // leaving it without copy — as the first version of this map did — made the loud failure silent.
  config: "Sign-in is misconfigured on the server. Contact your administrator.",
  failed: "Sign-in failed. Please try again.",
};

/**
 * Never render a blank form for a refusal we have no copy for. The map above must be kept in step
 * with the callback's `refuse(...)` codes, and it already fell behind once (`config` and `failed`
 * were emitted with no entry, so the page showed nothing at all). A generic fallback makes the
 * next such gap a vague message rather than an invisible one.
 */
function ssoErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return SSO_ERRORS[code] ?? "Sign-in failed. Please try again.";
}

/**
 * M12 12.3 login form — a client island. POSTs {email,password} JSON to the same-origin
 * /api/auth/login route handler (which forwards to ingest and sets the httpOnly session cookie,
 * D8 — the token never touches client JS). On success it navigates to the `next` param (the page
 * the middleware bounced from) or /monitor. Mirrors the mutation discipline of project-create.tsx:
 * check res.ok, disable in-flight, surface a friendly error.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // M15 15.7: seeded from `?error=` so a callback refusal is explained on the form the user lands
  // back on, rather than lost in a redirect.
  const [error, setError] = useState<string | null>(() =>
    ssoErrorMessage(searchParams.get("error")),
  );
  const [providers, setProviders] = useState<string[]>([]);

  // Which SSO buttons can actually work. Fetched rather than baked in: a provider is live only
  // when the operator configured BOTH halves of its credentials, and rendering a button that
  // cannot complete is worse than rendering none.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/sso/providers")
      .then((r) => (r.ok ? r.json() : { providers: [] }))
      .then((b: { providers?: string[] }) => {
        if (!cancelled) setProviders(b.providers ?? []);
      })
      .catch(() => {});
    return () => {
      // Armed before the component can unmount mid-flight, so a late resolve cannot setState on a
      // dead island (the long-lived-resource discipline, at its smallest).
      cancelled = true;
    };
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (res.ok) {
        // M15 15.7: the same-origin guard now lives in `lib/safe-next.ts`, shared with the SSO
        // callback. One definition — two call sites that must not drift apart.
        router.push(safeNext(searchParams.get("next")));
        router.refresh();
        return;
      }
      if (res.status === 401) setError("Invalid email or password.");
      else if (res.status === 502) setError("Archive unreachable.");
      else {
        // Surface a server-provided message when present (e.g. the SESSION_SECRET misconfig — D.3)
        // so a setup mistake is visible on the form instead of a bare status code.
        const msg = await res
          .json()
          .then((b: { error?: string }) => b?.error)
          .catch(() => undefined);
        setError(msg ?? `Login failed (${res.status}).`);
      }
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="pt-6">
        <h1 className="mb-1 font-mono text-lg font-bold tracking-tight">420AI</h1>
        <p className="text-muted-foreground mb-5 text-sm">Sign in to the archive.</p>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="username"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            aria-label="Email"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            aria-label="Password"
          />
          <button
            type="submit"
            disabled={!email.trim() || !password || busy}
            className={cn(
              "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {error ? <span className="text-destructive text-xs">{error}</span> : null}
        </form>
        {providers.length > 0 ? (
          <div className="mt-5">
            <div className="border-border mb-4 border-t" />
            <div className="flex flex-col gap-2">
              {providers.map((id) => (
                // ANCHORS, not `fetch`: this is a top-level navigation to a third party, and an
                // XHR cannot follow one. The `next` param rides along so the provider round trip
                // lands where the middleware originally bounced the user from.
                <a
                  key={id}
                  href={`/api/auth/sso/${id}/start?mode=login&next=${encodeURIComponent(
                    safeNext(searchParams.get("next")),
                  )}`}
                  className={cn(
                    "rounded-md border px-4 py-2 text-center text-sm font-medium transition-colors",
                    "border-border hover:bg-muted",
                  )}
                >
                  Sign in with {SSO_PROVIDER_LABELS[id] ?? id}
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
