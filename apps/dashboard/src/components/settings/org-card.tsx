"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FORBIDDEN_MESSAGE } from "@/lib/mutation-error";

/**
 * M15 15.10 — the organization card, a client island beside `<SsoLinks/>` and `<MfaCard/>`.
 *
 * IT RENDERS NOTHING UNTIL THE ORG HAS MORE THAN ONE MEMBER (D-M15-10), and that is the milestone's
 * zero-friction promise rather than a layout preference: a single user must never see an
 * "organization" at all. The whole multi-user apparatus is invisible until a second person exists.
 *
 * THE GATE IS `memberCount`, NEVER `isPersonal`. The flag records PROVENANCE — which row the 15.1
 * backfill seeded — and stays true for an org that has since grown a team; branching on it would
 * hide the card from exactly the deployment that needs it. (See `renameOrg`'s comment for why the
 * flag is deliberately not cleared on rename.)
 *
 * NO `router.refresh()`: this island owns its own data (`settings/page.tsx` passes it nothing), so
 * a server re-render cannot change anything rendered here — and it would re-run `GET /v1/monitor`,
 * which performs an alert reconcile (CLAUDE.md 15.4). `<SsoLinks/>`/`<MfaCard/>` call it, but they
 * predate that observation; do not re-add it here by pattern-matching.
 *
 * Renaming is `owner`-only upstream, so the field is shown only to an owner — courtesy, not
 * enforcement; the 403 is the gate. The rename exists because `ensurePersonalOrg` seeds the org
 * name from the user's EMAIL ADDRESS, so without it a colleague's first sight of the org is
 * `sean@example.com` with no way to change it.
 */

interface Org {
  id: string;
  name: string;
  isPersonal: boolean;
  memberCount: number;
  yourRole: string;
}

export function OrgCard() {
  const [org, setOrg] = useState<Org | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (): Promise<Org | null> => {
    return fetch("/api/org")
      .then((r) => (r.ok ? (r.json() as Promise<Org>) : null))
      .catch(() => null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((o) => {
      if (cancelled) return;
      setOrg(o);
      setName(o?.name ?? "");
    });
    // Armed before the first await resolves, so a navigation mid-fetch cannot setState on an
    // unmounted island.
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function rename(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/org", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setError(res.status === 403 ? FORBIDDEN_MESSAGE : "Could not rename the organization.");
        return;
      }
      // Guarded for the same reason `api-keys-card.tsx` guards its reload: `load()` returns null
      // on any non-ok/throw, and `org === null` makes this card render NOTHING — so a blip on the
      // follow-up GET would make the whole Organization card vanish right after a successful
      // rename, which reads as "the rename deleted the org".
      const refreshed = await load();
      if (refreshed) setOrg(refreshed);
      setSaved(true);
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
    }
  }

  // D-M15-10: a solo org renders NOTHING — not an empty shell, not a placeholder. `null` while
  // loading too, so a single-user deployment never sees the card flash in and disappear.
  if (!org || org.memberCount <= 1) return null;

  const isOwner = org.yourRole === "owner";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Organization</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-xs">
          {org.memberCount} members · you are {org.yourRole}
        </p>
        {isOwner ? (
          <form onSubmit={(e) => void rename(e)} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="org-name" className="text-muted-foreground text-xs font-medium">
                Name
              </label>
              <input
                id="org-name"
                type="text"
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                className="border-border bg-background rounded-md border px-3 py-1.5 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={busy || name.trim() === org.name}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                "border-border hover:bg-muted disabled:opacity-50",
              )}
            >
              {busy ? "Saving…" : "Rename"}
            </button>
            {saved ? <span className="text-muted-foreground text-xs">Saved.</span> : null}
          </form>
        ) : (
          <p className="text-sm font-medium">{org.name}</p>
        )}
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
