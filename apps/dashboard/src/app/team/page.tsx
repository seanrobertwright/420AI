import { getIngestJson } from "@/lib/ingest";
import { PageShell } from "@/components/page-shell";
import { TeamView } from "@/components/team/team-view";

/**
 * M15 15.10 — `/team`: the roster, the pending invites, and the four mutations that nine slices
 * shipped as curl-only endpoints.
 *
 * A Server Component fetches the two READS every account can perform (`/v1/members` and `/v1/org`,
 * both gated at `viewer`) so the roster is in the first paint. The invites panel is deliberately NOT
 * fetched here: `GET /v1/invites` is `admin`-gated, and a 403 is an EXPECTED answer for a viewer
 * rather than an error — so the island fetches it itself and treats 403 as "no panel". The page must
 * still render for a viewer.
 */
export const dynamic = "force-dynamic";

interface Member {
  userId: string;
  email: string;
  role: string;
  joinedAt: string;
}

interface Org {
  id: string;
  name: string;
  isPersonal: boolean;
  memberCount: number;
  yourRole: string;
}

export default async function TeamPage() {
  const [membersResponse, org] = await Promise.all([
    getIngestJson<{ members: Member[] }>("/v1/members"),
    getIngestJson<Org>("/v1/org"),
  ]);

  /*
   * AN UNREACHABLE ARCHIVE IS NOT AN EMPTY TEAM. `getIngestJson` returns null on any non-200 or
   * throw, and substituting `[]` would render "Team · 0 members" with an empty table — a statement
   * that is never true in a healthy deployment, since the caller is by construction a member of
   * their own org. `TeamView` only re-fetches INVITES on mount, so that lie would persist until a
   * manual reload. Say what actually happened instead.
   */
  if (!membersResponse) {
    return (
      <PageShell title="Team">
        <p className="text-muted-foreground text-sm">
          Could not reach the archive. Refresh to try again.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Team"
      subtitle={
        org
          ? `${org.name} · ${org.memberCount} member${org.memberCount === 1 ? "" : "s"}`
          : undefined
      }
    >
      {/* `yourRole` falls back to `viewer` when /v1/org is unreachable: fail CLOSED, so a blip
          hides controls rather than offering ones the server will refuse. */}
      <TeamView members={membersResponse.members} yourRole={org?.yourRole ?? "viewer"} />
    </PageShell>
  );
}
