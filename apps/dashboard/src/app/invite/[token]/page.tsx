import { ingestUrl } from "@/lib/ingest";
import { InviteAcceptForm } from "@/components/invite/invite-accept-form";

/**
 * M15 15.10 — THE PAGE THE MILESTONE'S EMAIL HAS BEEN LINKING TO SINCE 15.5.
 *
 * `apps/ingest/src/routes/members.ts` mails every invited colleague a link to
 * `${appBaseUrl}/invite/${token}`, and until this file existed that link 404'd — so the flagship
 * onboarding path of the whole milestone dead-ended, and an admin could only onboard someone by
 * reading the token out of a JSON response and passing it over Slack to `curl`.
 *
 * PUBLIC BY CONSTRUCTION, and that takes TWO deliberate exemptions, both of which fail in ways that
 * look like a backend bug:
 *   1. `lib/public-paths.ts`'s `/invite/` PREFIX — the middleware matches its static list by exact
 *      equality, so without it this page redirects to `/login?next=/invite/<token>`;
 *   2. `app-nav.tsx`'s prefix list — without it a visitor with no session is shown the full
 *      authenticated chrome, Logout included, with every link bouncing to `/login`.
 *
 * A SERVER COMPONENT fetches the preview so the org name and role are in the first paint, with NO
 * `adminHeaders()`: the visitor has no session, and the token IS the credential. Mirrors
 * `settings/page.tsx`'s local `getJson`, but this one keeps the STATUS, because a 410's `reason` is
 * the difference between "expired" and "already used" and both are terminal states worth naming.
 */
export const dynamic = "force-dynamic";

interface InvitePreview {
  email: string;
  role: string;
  orgName: string | null;
  expiresAt: string;
}

type PreviewResult =
  | { kind: "ok"; preview: InvitePreview }
  | { kind: "gone"; reason: string }
  | { kind: "unreachable" };

async function loadPreview(token: string): Promise<PreviewResult> {
  try {
    const res = await fetch(`${ingestUrl()}/v1/auth/invites/${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
    if (res.ok) return { kind: "ok", preview: (await res.json()) as InvitePreview };
    if (res.status === 410) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      return { kind: "gone", reason: body.reason ?? "unknown" };
    }
    return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

/** Terminal-state copy. Every branch says what to DO — there is no retry that helps any of them. */
const GONE_COPY: Record<string, string> = {
  expired: "This invitation has expired. Ask an admin to send you a new one.",
  revoked: "This invitation was revoked. Ask an admin to send you a new one.",
  accepted: "This invitation has already been used. Try signing in instead.",
  unknown: "This invitation link is not valid. Ask an admin to send you a new one.",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await loadPreview(token);

  if (result.kind !== "ok") {
    return (
      <main className="flex min-h-[70vh] items-center justify-center px-6">
        <div className="border-border bg-card w-full max-w-sm rounded-lg border p-6">
          <h1 className="text-lg font-semibold tracking-tight">Invitation unavailable</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {result.kind === "gone"
              ? (GONE_COPY[result.reason] ?? GONE_COPY.unknown)
              : "The archive is unreachable right now. Try again in a moment."}
          </p>
          <a
            href="/login"
            className="text-primary mt-4 inline-block text-sm font-medium hover:underline"
          >
            Go to sign in
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      {/* The token is passed to the client island because the accept POST carries it. It is
          already in the URL the visitor is looking at, so this exposes nothing new — but it is
          never rendered in visible copy. */}
      <InviteAcceptForm
        token={token}
        email={result.preview.email}
        role={result.preview.role}
        orgName={result.preview.orgName}
        expiresAt={result.preview.expiresAt}
      />
    </main>
  );
}
