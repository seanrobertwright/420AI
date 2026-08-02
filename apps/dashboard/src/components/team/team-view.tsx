"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { FORBIDDEN_MESSAGE } from "@/lib/mutation-error";

/**
 * M15 15.10 — the team surface's client island. Mirrors `settings/sso-links.tsx` exactly: a
 * `useCallback` loader, a `let cancelled = false` cleanup armed before the first await resolves,
 * per-row `busy` state keyed by id, status-specific error copy, and `router.refresh()` after a
 * successful mutation so the server-rendered header (member count) follows.
 *
 * ROLE GATING HERE IS COURTESY, NEVER ENFORCEMENT. Every endpoint behind these controls is
 * `admin`-gated upstream and additionally enforces 15.5's ceiling ("you may not grant above your
 * own rung") and floor ("you may not act on someone who outranks you"). Hiding a button a `viewer`
 * may not press is a nicety; the 403 is the gate. Both halves matter — a UI that renders controls a
 * user cannot use is a worse experience, and a UI that relies on hiding them is a vulnerability.
 *
 * The invites panel is fetched HERE rather than on the server, because `GET /v1/invites` is
 * `admin`-gated: a 403 is an expected answer for a `viewer` and means "render no panel", not "an
 * error occurred". The roster must load either way.
 */

const ROLES = ["viewer", "member", "admin", "owner"] as const;
const RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

interface Member {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Mirrors the server's `outranks` (`hasRole` is `>=`, so EQUAL RANK IS ALLOWED — two owners must be
 * able to administer each other, or a co-owner would be unremovable). Unknown roles fail CLOSED, as
 * the server's does: a hand-edited membership row makes the UI hide a control rather than offer one
 * that will 403.
 */
function outranks(actorRole: string, targetRole: string): boolean {
  const a = RANK[actorRole];
  const t = RANK[targetRole];
  return a !== undefined && t !== undefined && a >= t;
}

export function TeamView({ members, yourRole }: { members: Member[]; yourRole: string }) {
  const router = useRouter();
  /**
   * FIRST-PAINT SEED ONLY. React ignores a changed `members` prop once this component is mounted,
   * so `router.refresh()` re-rendering the server page does NOT update this table — `refreshAll()`
   * owns every subsequent update by re-fetching `/api/members` itself. The two are deliberately
   * redundant: the server fetch is what puts the roster in the first paint, the client fetch is
   * what keeps it current. Do not drop the client re-fetch on the assumption that
   * `router.refresh()` covers it; the table would silently stop updating after every mutation.
   */
  const [roster, setRoster] = useState<Member[]>(members);
  /** `null` = not loaded yet; `[]` = loaded and empty; `"forbidden"` = a viewer, render no panel. */
  const [invites, setInvites] = useState<Invite[] | "forbidden" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("member");
  /**
   * The invite token, shown ONLY when the deployment has no mailer (or SMTP failed) and ingest
   * therefore hands it back for the admin to pass on out-of-band (D-15.5-10). Held in memory only
   * and never re-fetched: only its sha256 is stored, so this is the one and only chance to copy it.
   */
  const [handoffToken, setHandoffToken] = useState<string | null>(null);

  const isAdmin = RANK[yourRole] !== undefined && RANK[yourRole] >= RANK.admin;

  const loadMembers = useCallback(async (): Promise<Member[] | null> => {
    return fetch("/api/members")
      .then((r) => (r.ok ? (r.json() as Promise<{ members: Member[] }>) : null))
      .then((d) => d?.members ?? null)
      .catch(() => null);
  }, []);

  const loadInvites = useCallback(async (): Promise<Invite[] | "forbidden" | null> => {
    try {
      const res = await fetch("/api/invites");
      // 403 is the EXPECTED answer for a viewer, not a failure — see the header.
      if (res.status === 403) return "forbidden";
      if (!res.ok) return null;
      const body = (await res.json()) as { invites: Invite[] };
      return body.invites ?? [];
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadInvites().then((i) => {
      if (!cancelled) setInvites(i);
    });
    // Armed before the first await resolves, so a navigation mid-fetch cannot setState on an
    // unmounted island.
    return () => {
      cancelled = true;
    };
  }, [loadInvites]);

  /**
   * A 401 on THIS page almost always means the mutation just performed targeted the caller.
   *
   * `outranks` permits EQUAL rank by design, so an owner may legitimately press "Reset 2FA" or
   * "Remove" on their own row — and both revoke the target's sessions, deliberately (clearing MFA
   * while leaving a session alive is strictly worse than doing nothing). The session revoked is the
   * one making the request, so every subsequent fetch 401s: without this branch the loaders swallow
   * that to `null`, the roster silently freezes at its pre-mutation state, and the user is left
   * looking at a success message on a page that no longer works.
   *
   * A HARD navigation, not `router.push`: only a full request makes the middleware re-gate with the
   * (now absent) cookie. Same reason `app-nav.tsx`'s logout does it this way.
   *
   * Returns true when it has taken over, so callers stop rather than also showing an error.
   */
  function bounceIfSignedOut(status: number): boolean {
    if (status !== 401) return false;
    window.location.href = "/login";
    return true;
  }

  /** One place that turns a failed mutation into copy, so every 403 reads the same (15.4). */
  function reportFailure(status: number, fallback: string): void {
    // Belt-and-braces behind `bounceIfSignedOut`: if a 401 ever reaches here, say the one true
    // thing about it rather than "Could not change that role", which reads as transient and
    // invites the retry that cannot work.
    if (status === 401) setError("Your session has ended. Sign in again.");
    else if (status === 403) setError(FORBIDDEN_MESSAGE);
    else if (status === 409) setError("That change conflicts with the current state.");
    else if (status === 404) setError("That person is no longer in this organization.");
    else setError(fallback);
  }

  async function refreshAll(): Promise<void> {
    const [m, i] = await Promise.all([loadMembers(), loadInvites()]);
    if (m) setRoster(m);
    setInvites(i);
    router.refresh();
  }

  async function invite(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy("invite");
    setError(null);
    setNotice(null);
    setHandoffToken(null);
    try {
      const res = await fetch("/api/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      if (!res.ok) {
        if (bounceIfSignedOut(res.status)) return;
        if (res.status === 409) {
          // The three-way rejection (already a member / user exists / invite pending) — the
          // upstream message names which, and it is more useful than anything generic here.
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "That address cannot be invited.");
        } else {
          reportFailure(res.status, "Could not send the invitation.");
        }
        return;
      }
      const body = (await res.json()) as { mailed?: boolean; token?: string };
      setInviteEmail("");
      if (body.mailed) {
        setNotice(`Invitation emailed.`);
      } else if (body.token) {
        // No mailer configured (or SMTP failed): the token comes back for out-of-band handoff.
        setHandoffToken(body.token);
      } else {
        setNotice("Invitation created.");
      }
      await refreshAll();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(userId: string, role: string): Promise<void> {
    setBusy(userId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/members/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        if (bounceIfSignedOut(res.status)) return;
        reportFailure(res.status, "Could not change that role.");
        return;
      }
      await refreshAll();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(userId: string): Promise<void> {
    setBusy(userId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        if (bounceIfSignedOut(res.status)) return;
        // 409 here is the LAST-OWNER guard specifically, so it gets its own wording.
        if (res.status === 409) setError("An organization must always have at least one owner.");
        else reportFailure(res.status, "Could not remove that member.");
        return;
      }
      await refreshAll();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  async function resetMfa(userId: string): Promise<void> {
    setBusy(userId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/members/${userId}/mfa`, { method: "DELETE" });
      if (!res.ok) {
        if (bounceIfSignedOut(res.status)) return;
        reportFailure(res.status, "Could not reset two-factor authentication.");
        return;
      }
      // Say what it DID, because it did two things: the sessions revoke is not optional and the
      // person will be signed out.
      setNotice("Two-factor authentication cleared and their sessions were signed out.");
      await refreshAll();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeInvite(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/invites/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        if (bounceIfSignedOut(res.status)) return;
        reportFailure(res.status, "Could not revoke that invitation.");
        return;
      }
      await refreshAll();
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Members</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                {isAdmin ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {roster.map((m) => {
                // The FLOOR, mirrored: a control that would 403 is not offered.
                const mayAct = isAdmin && outranks(yourRole, m.role);
                return (
                  <TableRow key={m.userId}>
                    <TableCell className="font-medium">{m.email}</TableCell>
                    <TableCell>
                      {mayAct ? (
                        <select
                          value={m.role}
                          disabled={busy === m.userId}
                          onChange={(e) => void changeRole(m.userId, e.target.value)}
                          className="border-border bg-background rounded-md border px-2 py-1 text-xs"
                        >
                          {ROLES.map((r) => (
                            // The CEILING, mirrored: you may not grant a rung above your own.
                            <option key={r} value={r} disabled={!outranks(yourRole, r)}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-muted-foreground text-xs">{m.role}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatDate(m.joinedAt)}
                    </TableCell>
                    {isAdmin ? (
                      <TableCell className="text-right">
                        {mayAct ? (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => void resetMfa(m.userId)}
                              disabled={busy === m.userId}
                              className={cn(
                                "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                                "border-border hover:bg-muted disabled:opacity-50",
                              )}
                            >
                              Reset 2FA
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(m.userId)}
                              disabled={busy === m.userId}
                              className={cn(
                                "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                                "border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50",
                              )}
                            >
                              Remove
                            </button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Rendered only for an admin — a viewer gets a 403 from `/api/invites` and must not see a
          broken panel. `null` means "still loading", which is also not a panel. */}
      {invites !== "forbidden" && invites !== null ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Invite a colleague</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={(e) => void invite(e)} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label htmlFor="invite-email" className="text-muted-foreground text-xs font-medium">
                  Email
                </label>
                <input
                  id="invite-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="border-border bg-background rounded-md border px-3 py-1.5 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="invite-role" className="text-muted-foreground text-xs font-medium">
                  Role
                </label>
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="border-border bg-background rounded-md border px-3 py-1.5 text-sm"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r} disabled={!outranks(yourRole, r)}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={busy === "invite"}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                  "border-border hover:bg-muted disabled:opacity-50",
                )}
              >
                {busy === "invite" ? "Inviting…" : "Send invite"}
              </button>
            </form>

            {handoffToken ? (
              <div className="border-border bg-muted/40 space-y-1 rounded-md border p-3">
                <p className="text-xs font-medium">
                  No mailer is configured, so pass this link on yourself. It is shown once.
                </p>
                {/* AN ABSOLUTE URL, not a path. This is the SUPPORTED no-SMTP workflow
                    (D-15.5-10), so a solo self-hosted operator hits it on every onboarding — and
                    the copy above says "pass this link on", which a bare `/invite/<token>` is not.
                    The origin comes from the browser, so it is by definition the host the admin is
                    already reaching the dashboard on. `handoffToken` is only ever set by a client
                    mutation, so `window` exists by the time this renders; the guard is for the
                    server pass, where it is null and this block does not render at all. */}
                <code className="block break-all font-mono text-xs">
                  {`${typeof window === "undefined" ? "" : window.location.origin}/invite/${handoffToken}`}
                </code>
              </div>
            ) : null}

            {invites.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pending invitation</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.email}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{i.role}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDate(i.expiresAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <button
                          type="button"
                          onClick={() => void revokeInvite(i.id)}
                          disabled={busy === i.id}
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                            "border-border hover:bg-muted disabled:opacity-50",
                          )}
                        >
                          Revoke
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground text-xs">No pending invitations.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {notice ? <p className="text-muted-foreground text-sm">{notice}</p> : null}
    </div>
  );
}
