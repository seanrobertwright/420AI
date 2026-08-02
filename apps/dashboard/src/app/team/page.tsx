import { ingestUrl, adminHeaders } from "@/lib/ingest";
import { PageShell } from "@/components/page-shell";
import { TeamView } from "@/components/team/team-view";

/**
 * M15 15.10 — `/team`: the roster, the pending invites, and the four mutations that nine slices
 * shipped as curl-only endpoints.
 *
 * A Server Component fetches the two READS that every account can perform (`/v1/members` and
 * `/v1/org`, both gated at `viewer`) so the roster is in the first paint. The invites panel is
 * deliberately NOT fetched here: `GET /v1/invites` is `admin`-gated, and a 403 during a server
 * render would have to be branched on anyway — so the island fetches it itself and treats a 403 as
 * "no panel", never as an error. The page must still render for a `viewer`.
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

/** GET ingest JSON on the server→ingest hop (D8), returning null on any non-200/throw. */
async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${ingestUrl()}${path}`, {
      headers: await adminHeaders(),
      cache: "no-store",
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export default async function TeamPage() {
  const [membersResponse, org] = await Promise.all([
    getJson<{ members: Member[] }>("/v1/members"),
    getJson<Org>("/v1/org"),
  ]);

  return (
    <PageShell
      title="Team"
      subtitle={
        org
          ? `${org.name} · ${org.memberCount} member${org.memberCount === 1 ? "" : "s"}`
          : undefined
      }
    >
      <TeamView members={membersResponse?.members ?? []} yourRole={org?.yourRole ?? "viewer"} />
    </PageShell>
  );
}
