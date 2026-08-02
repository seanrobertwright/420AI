"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

/**
 * M15 15.10 — the invite redemption form. Mirrors `auth/login-form.tsx`'s shape and
 * `settings/sso-links.tsx`'s error discipline: one `busy` flag, status-specific copy, and no
 * generic "something went wrong".
 *
 * THE EMAIL IS READ-ONLY, deliberately. The invitation is bound to one address (the token's row
 * names it), so an editable field would only ever produce a refusal the user cannot understand.
 *
 * On success it does a HARD navigation (`window.location.href`) rather than `router.push`: the
 * session cookie was just set by the accept route, and only a full request makes the middleware
 * re-gate with it. A client-side push would render the next page against the previous, sessionless
 * routing state.
 */
export function InviteAcceptForm({
  token,
  email,
  role,
  orgName,
  expiresAt,
}: {
  token: string;
  email: string;
  role: string;
  orgName: string | null;
  expiresAt: string;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        window.location.href = "/monitor";
        return;
      }
      // Each status is a DIFFERENT thing to do about it, which is why they are not collapsed.
      if (res.status === 409) {
        setError(
          "An account already exists for this address. Ask your admin to add you to the organization instead.",
        );
      } else if (res.status === 410) {
        setError("This invitation is no longer valid. Ask an admin to send you a new one.");
      } else if (res.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
      } else if (res.status === 400) {
        setError("That password was rejected. Try a longer one.");
      } else {
        setError("Could not accept the invitation. Please try again.");
      }
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
      // The password never outlives the request that used it — the same discipline `mfa-card.tsx`
      // applies to its re-auth field.
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="border-border bg-card w-full max-w-sm space-y-4 rounded-lg border p-6"
    >
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          Join {orgName ?? "this organization"}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          You have been invited as <span className="font-medium">{role}</span>. Choose a password to
          finish setting up your account.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="invite-email" className="text-muted-foreground text-xs font-medium">
          Email
        </label>
        <input
          id="invite-email"
          type="email"
          value={email}
          readOnly
          className="border-border bg-muted/40 text-muted-foreground w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="invite-password" className="text-muted-foreground text-xs font-medium">
          Password
        </label>
        <input
          id="invite-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="invite-confirm" className="text-muted-foreground text-xs font-medium">
          Confirm password
        </label>
        <input
          id="invite-confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="border-border bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className={cn(
          "bg-primary text-primary-foreground w-full rounded-md px-3 py-2 text-sm font-medium",
          "transition-opacity hover:opacity-90 disabled:opacity-50",
        )}
      >
        {busy ? "Joining…" : "Accept invitation"}
      </button>

      <p className="text-muted-foreground text-xs">
        This invitation expires {formatDate(expiresAt)}.
      </p>
    </form>
  );
}
