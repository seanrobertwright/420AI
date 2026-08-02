"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * M15 15.8 — the two-factor enrolment surface, a client island inside the existing Settings page (no
 * new route), mirroring `sso-links.tsx`. Every hop goes through a same-origin proxy route handler, so
 * the session token stays httpOnly and the browser never holds a credential (D8).
 *
 * NO QR CODE (D-15.8-14). The card shows the base32 secret grouped in fours for manual entry plus the
 * `otpauth://` URI; every mainstream authenticator accepts manual entry. A QR needs either a new
 * dashboard dependency or ~300 lines of hand-rolled encoder, and it belongs with the account
 * surfaces. 15.10 shipped those and held its no-new-dependency line, so this remains deferred —
 * stated scope, not an oversight.
 */

interface MfaStatus {
  enabled: boolean;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
  /**
   * D-15.8-16 — whether `enroll` will ask for the current password. False for an SSO-only account,
   * which has none and re-proves with session recency instead. Reported by the server rather than
   * guessed here, because the branch depends on a `users` row the browser cannot see.
   */
  passwordRequiredToEnrol: boolean;
}

/** Group a base32 secret in fours — a human is about to retype it into a phone. */
function grouped(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function MfaCard() {
  const router = useRouter();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set while an enrolment is pending confirmation — phase one's response. */
  const [pending, setPending] = useState<{ secret: string; otpauthUri: string } | null>(null);
  /**
   * The recovery codes, held ONLY in memory and ONLY until the user dismisses the block. There is no
   * endpoint that could fetch them again (they are stored hashed, D-15.8-7), so this state is the one
   * and only chance to save them — which is why the UI says so explicitly and never re-fetches.
   */
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  /**
   * D-15.8-16 re-authentication. Held only for the duration of the enrol request and cleared
   * immediately afterwards, success or failure — a password lingering in island state is one stray
   * re-render away from being somewhere it should not be.
   */
  const [currentPassword, setCurrentPassword] = useState("");

  const load = useCallback(async (): Promise<MfaStatus | null> => {
    return fetch("/api/auth/mfa")
      .then((r) => (r.ok ? (r.json() as Promise<MfaStatus>) : null))
      .catch(() => null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((s) => {
      if (!cancelled) setStatus(s);
    });
    // Armed BEFORE the first await resolves, so a navigation mid-fetch cannot setState on an
    // unmounted island (the long-lived-resource discipline, at its smallest).
    return () => {
      cancelled = true;
    };
  }, [load]);

  /** Read a `reason` out of a failed response so the copy can be specific. */
  async function reasonOf(res: Response): Promise<string | undefined> {
    return res
      .json()
      .then((b: { reason?: string }) => b?.reason)
      .catch(() => undefined);
  }

  async function beginEnroll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Omitted entirely for an SSO-only account — the server re-proves with session recency.
        body: JSON.stringify(
          status?.passwordRequiredToEnrol ? { currentPassword: currentPassword } : {},
        ),
      });
      if (!res.ok) {
        const reason = await reasonOf(res);
        setError(
          reason === "already_enrolled"
            ? "Two-factor is already enabled. Disable it first to enrol a new device."
            : reason === "password_required"
              ? "That password is not correct."
              : reason === "reauth_required"
                ? // The only remedy for an SSO-only account, so the copy has to name it.
                  "For your security, sign out and sign in again before enabling two-factor."
                : "Could not start enrolment. Please try again.",
        );
        return;
      }
      setPending((await res.json()) as { secret: string; otpauthUri: string });
      setCode("");
    } catch {
      setError("Archive unreachable.");
    } finally {
      // Cleared on EVERY path, including success — see the state declaration.
      setCurrentPassword("");
      setBusy(false);
    }
  }

  async function confirmEnroll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/mfa/enroll/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        setError(
          res.status === 401
            ? "That code is not valid. Check your device's clock and try again."
            : "Could not confirm enrolment. Please try again.",
        );
        setCode("");
        return;
      }
      const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] };
      setCodes(recoveryCodes);
      setPending(null);
      setCode("");
      setStatus(await load());
      // Enrol-confirm revoked every OTHER session server-side; refresh so this tab's Server
      // Components re-render against the new state rather than a stale snapshot.
      router.refresh();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
    }
  }

  /** `disable` and `recovery-codes` differ only in path and success handling. */
  async function withCode(path: string, onOk: (body: unknown) => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        const reason = await reasonOf(res);
        setError(
          res.status === 429
            ? "Too many incorrect codes. Try again in a few minutes."
            : reason === "not_enrolled"
              ? "Two-factor is not enabled."
              : "That code is not valid. Please try again.",
        );
        setCode("");
        return;
      }
      // 204 has no body; only the regenerate path returns one.
      onOk(res.status === 204 ? null : await res.json());
      setCode("");
      setStatus(await load());
      router.refresh();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
    }
  }

  // Render nothing until the status is known, rather than flashing "not enrolled" at an enrolled
  // user — which would invite them to click Enable and get a 409.
  if (!status) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Two-factor authentication</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Badge
              className={cn(
                status.enabled
                  ? "border-transparent bg-emerald-500/15 text-emerald-400"
                  : "border-transparent bg-muted text-muted-foreground",
              )}
            >
              {status.enabled ? "enabled" : "not enabled"}
            </Badge>
            <p className="text-muted-foreground mt-2 truncate text-xs">
              {status.enabled && status.confirmedAt
                ? `Since ${formatDate(status.confirmedAt)} · ${status.recoveryCodesRemaining} recovery codes left`
                : "Require a code from an authenticator app when you sign in."}
            </p>
          </div>
          {!status.enabled && !pending && !status.passwordRequiredToEnrol ? (
            <button
              type="button"
              onClick={() => void beginEnroll()}
              disabled={busy}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                "border-border hover:bg-muted disabled:opacity-50",
              )}
            >
              {busy ? "Starting…" : "Enable"}
            </button>
          ) : null}
        </div>

        {/* D-15.8-16 — arming a second factor re-proves the password, exactly as changing the
            password does. Without it a stolen session cookie could enrol an attacker's authenticator
            and lock the real owner out permanently, since a password reset does not clear MFA. */}
        {!status.enabled && !pending && status.passwordRequiredToEnrol ? (
          <div className="border-border space-y-2 rounded-md border p-3">
            <p className="text-muted-foreground text-xs">
              Confirm your password to enable two-factor authentication.
            </p>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              autoComplete="current-password"
              className="border-border bg-background w-full rounded-md border px-3 py-1.5 text-sm"
              aria-label="Current password"
            />
            <button
              type="button"
              onClick={() => void beginEnroll()}
              disabled={busy || currentPassword.length === 0}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                "border-border hover:bg-muted disabled:opacity-50",
              )}
            >
              {busy ? "Starting…" : "Enable"}
            </button>
          </div>
        ) : null}

        {pending ? (
          <div className="border-border space-y-3 rounded-md border p-3">
            <p className="text-xs font-medium">1. Add this secret to your authenticator app</p>
            <p className="bg-muted rounded px-2 py-1.5 font-mono text-sm break-all select-all">
              {grouped(pending.secret)}
            </p>
            <p className="text-muted-foreground font-mono text-[10px] break-all select-all">
              {pending.otpauthUri}
            </p>
            <p className="text-xs font-medium">2. Enter the code it shows</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="border-border bg-background flex-1 rounded-md border px-3 py-1.5 font-mono text-sm"
                aria-label="Authentication code"
              />
              <button
                type="button"
                onClick={() => void confirmEnroll()}
                disabled={busy || code.trim().length < 6}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  "border-border hover:bg-muted disabled:opacity-50",
                )}
              >
                {busy ? "Confirming…" : "Confirm"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setPending(null);
                setCode("");
                setError(null);
              }}
              className="text-muted-foreground hover:text-foreground text-xs underline"
            >
              Cancel
            </button>
            <p className="text-muted-foreground text-xs">
              Nothing changes until you confirm — an abandoned enrolment never locks you out.
            </p>
          </div>
        ) : null}

        {codes ? (
          <div className="border-border space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium">
              Save these recovery codes now — they will not be shown again.
            </p>
            <pre className="bg-muted overflow-x-auto rounded px-2 py-1.5 font-mono text-[11px] select-all">
              {codes.join("\n")}
            </pre>
            <p className="text-muted-foreground text-xs">
              Each code works once. Use one if you lose access to your authenticator.
            </p>
            <button
              type="button"
              onClick={() => setCodes(null)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                "border-border hover:bg-muted",
              )}
            >
              I have saved them
            </button>
          </div>
        ) : null}

        {status.enabled && !codes ? (
          <div className="border-border space-y-2 rounded-md border p-3">
            <p className="text-muted-foreground text-xs">
              Changing these requires a current code (or a recovery code).
            </p>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Current code"
              inputMode="text"
              autoComplete="one-time-code"
              maxLength={64}
              className="border-border bg-background w-full rounded-md border px-3 py-1.5 font-mono text-sm"
              aria-label="Current authentication code"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void withCode("/api/auth/mfa/recovery-codes", (body) =>
                    setCodes((body as { recoveryCodes: string[] }).recoveryCodes),
                  )
                }
                disabled={busy || code.trim().length < 6}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  "border-border hover:bg-muted disabled:opacity-50",
                )}
              >
                Regenerate recovery codes
              </button>
              <button
                type="button"
                onClick={() => void withCode("/api/auth/mfa/disable", () => setPending(null))}
                disabled={busy || code.trim().length < 6}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  "border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50",
                )}
              >
                Disable
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
