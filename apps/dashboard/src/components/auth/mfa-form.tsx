"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeNext } from "@/lib/safe-next";

/**
 * M15 15.8 — the second step of a login. A client island that POSTs only the CODE to the same-origin
 * `/api/auth/mfa/verify` handler; the challenge itself rides in an httpOnly cookie the browser cannot
 * read (D8), so this component never holds half a credential.
 *
 * Mirrors `login-form.tsx`'s mutation discipline: check `res.ok`, disable in flight, surface friendly
 * copy for every status the server can answer with.
 */

/**
 * Copy for each refusal the exchange can return. `expired` is the one that matters: a user who left
 * the tab open past the five-minute TTL must be told to start again, or they retype a correct code
 * repeatedly and conclude their authenticator is broken.
 */
const MFA_ERRORS: Record<string, string> = {
  expired: "That sign-in attempt expired. Please sign in again.",
  locked:
    "Too many incorrect codes. Try again later, or use a recovery code once the lock expires.",
  invalid: "That code is not valid. Check your authenticator and try again.",
};

export function MfaForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (res.ok) {
        // Identical to the login form at :94-95 — `safeNext` is the shared same-origin guard, and
        // `refresh()` is what makes the freshly-set session cookie visible to the Server Components.
        router.push(safeNext(searchParams.get("next")));
        router.refresh();
        return;
      }
      const body = await res
        .json()
        .then((b: { reason?: string; error?: string }) => b)
        .catch(() => ({}) as { reason?: string; error?: string });
      if (res.status === 502) setError("Archive unreachable.");
      else if (body.reason && MFA_ERRORS[body.reason]) setError(MFA_ERRORS[body.reason]!);
      else if (res.status === 401) setError(MFA_ERRORS.invalid!);
      else setError(body.error ?? `Verification failed (${res.status}).`);
      // The code is cleared on every failure: a TOTP code is single-use even when it was correct
      // (RFC 6238 §5.2), so leaving it in the field invites a retry that cannot succeed.
      setCode("");
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="pt-6">
        <h1 className="mb-1 font-mono text-lg font-bold tracking-tight">Two-factor</h1>
        <p className="text-muted-foreground mb-5 text-sm">
          {useRecovery
            ? "Enter one of your saved recovery codes."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            // `one-time-code` is what lets iOS/Android offer the code from the notification, and
            // `inputMode="numeric"` brings up the number pad. Both are dropped in recovery mode —
            // a recovery code is base64url, so a numeric mask would make it untypeable.
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={useRecovery ? "Recovery code" : "123456"}
            inputMode={useRecovery ? "text" : "numeric"}
            autoComplete={useRecovery ? "off" : "one-time-code"}
            autoFocus
            maxLength={useRecovery ? 64 : 6}
            className="border-border bg-background rounded-md border px-3 py-2 font-mono text-sm"
            aria-label={useRecovery ? "Recovery code" : "Authentication code"}
          />
          <button
            type="submit"
            disabled={code.trim().length < 6 || busy}
            className={cn(
              "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
          {error ? <span className="text-destructive text-xs">{error}</span> : null}
        </form>
        <button
          type="button"
          onClick={() => {
            // The toggle ONLY relaxes the input mask. The server accepts either credential on the
            // same field and decides by shape (`verifyTotp` rejects anything that is not six digits
            // before any HMAC), so there is no mode to get out of step with the backend.
            setUseRecovery((v) => !v);
            setCode("");
            setError(null);
          }}
          className="text-muted-foreground hover:text-foreground mt-4 text-xs underline"
        >
          {useRecovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
        </button>
      </CardContent>
    </Card>
  );
}
