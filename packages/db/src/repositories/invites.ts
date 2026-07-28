import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { invites, memberships } from "../schema.js";
import { generateToken, hashToken } from "../tokens.js";
import { normalizeEmail } from "./users.js";

/**
 * M15 15.5 — organization invitations (D-M15-5). Silent library (CLAUDE.md): throws typed
 * errors, never logs. The lifecycle is `pairing_codes`' lifecycle exactly — mint a short-lived
 * single-use credential, then redeem-and-mark-consumed atomically — which is why 0017 gives
 * `invites` the same BOOTSTRAP-PERMISSIVE org policy (D-15.3-3) and why `findInviteByToken`
 * carries the same AUTH BOUNDARY warning `redeemPairingCode` does.
 *
 * The one difference from `pairing_codes`, and it is the reason `invites` also carries the 15.4
 * RESTRICTIVE role-write policies (D-15.5-2): an invite GRANTS PRIVILEGE. A pairing code names a
 * machine; an invite names a rung on the role ladder, so a viewer minting `role: 'owner'` is
 * precisely the escalation the backstop exists for. The ROUTE gate is the strict layer
 * (D-15.5-11 — "never grant above your own role"); the policy only ever asks "is this a viewer?".
 *
 * `DbClient`, not `Db`: every write reaches these from inside a caller's `withOrg` transaction,
 * and `acceptInvite`'s stamp-then-insert MUST share one transaction with the caller's user
 * creation or a crash between them leaves a consumed invite and no membership.
 */

/** Thrown when an invite token is unknown, already accepted, revoked, or expired. */
export class InviteError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown" | "accepted" | "expired" | "revoked",
  ) {
    super(message);
    this.name = "InviteError";
  }
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — a colleague must have time to read mail

export interface InviteRow {
  id: string;
  email: string;
  role: string;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

/**
 * The columns an `InviteRow` is made of. EXPLICIT rather than `select()`/`returning()`, per the
 * 15.1 lesson: no ingest route declares a Fastify `response` schema, so nothing strips extra
 * properties and a bare select puts every future column on the wire. Keep this list ==
 * `InviteRow`.
 *
 * `org_id` and `token_hash` are deliberately ABSENT — the first is tenancy plumbing, the second
 * is a credential digest. Neither belongs on the wire.
 */
const inviteRowColumns = {
  id: invites.id,
  email: invites.email,
  role: invites.role,
  invitedByUserId: invites.invitedByUserId,
  expiresAt: invites.expiresAt,
  acceptedAt: invites.acceptedAt,
  createdAt: invites.createdAt,
};

/**
 * Mint an invite and return the PLAINTEXT token exactly once (D-15.5-8). Only `hashToken(token)`
 * is stored, same discipline as `ingest_tokens` — a DB leak exposes no usable invite.
 *
 * `orgId` is the SECOND parameter (CLAUDE.md 15.2 rule) so a transposition between two adjacent
 * `string` params is visible in review.
 */
export async function createInvite(
  db: DbClient,
  orgId: string,
  input: { email: string; role: string; invitedByUserId: string },
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<{ token: string; invite: InviteRow }> {
  const token = generateToken();
  const [row] = await db
    .insert(invites)
    .values({
      orgId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: hashToken(token),
      invitedByUserId: input.invitedByUserId,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .returning(inviteRowColumns);
  return { token, invite: row! };
}

/**
 * Resolve an invite by its plaintext token, INCLUDING its `orgId`.
 *
 * AUTH BOUNDARY (exactly like `redeemPairingCode` / `findMachineIdByToken`): the token IS the
 * credential, and this read is what ESTABLISHES the org context rather than running inside one.
 * It therefore takes NO `orgId` and must NOT be called inside a `withOrg` block — a strict policy
 * would read zero rows here, which is why 0017 makes `invites` bootstrap-permissive on the org
 * axis.
 *
 * Validation order is revoked → accepted → expired, so the `reason` a caller surfaces is the most
 * specific TRUE one rather than whichever check happened to run first.
 */
export async function findInviteByToken(
  db: DbClient,
  token: string,
): Promise<InviteRow & { orgId: string }> {
  const [row] = await db
    .select({ ...inviteRowColumns, orgId: invites.orgId, revokedAt: invites.revokedAt })
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) throw new InviteError("unknown invite", "unknown");
  if (row.revokedAt) throw new InviteError("invite revoked", "revoked");
  if (row.acceptedAt) throw new InviteError("invite already accepted", "accepted");
  if (row.expiresAt.getTime() < Date.now()) throw new InviteError("invite expired", "expired");

  const { revokedAt: _revokedAt, ...rest } = row;
  return rest;
}

/**
 * Redeem an invite for `userId`: validate, stamp `accepted_at`, and insert EXACTLY ONE
 * `memberships` row in the inviting org. Single-use, one transaction — mirroring
 * `redeemPairingCode`.
 *
 * The caller must have created the user via `createUserWithPassword` (NOT `setUserPassword`) in
 * this same transaction. `setUserPassword` calls `ensurePersonalOrg`, and because
 * `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)`, a personal `owner`
 * membership created first would SHADOW the row inserted here forever — the invite would read as
 * working and silently do nothing (GOTCHA-1 / D-15.5-9).
 */
export async function acceptInvite(
  tx: DbClient,
  token: string,
  userId: string,
): Promise<{ orgId: string; role: string }> {
  const invite = await findInviteByToken(tx, token);

  await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
  await tx.insert(memberships).values({ orgId: invite.orgId, userId, role: invite.role });

  return { orgId: invite.orgId, role: invite.role };
}

/** Every PENDING invite in an org (neither accepted nor revoked), oldest first. */
export async function listInvites(db: DbClient, orgId: string): Promise<InviteRow[]> {
  return db
    .select(inviteRowColumns)
    .from(invites)
    .where(and(eq(invites.orgId, orgId), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .orderBy(asc(invites.createdAt), asc(invites.id));
}

/**
 * Revoke a pending invite. Returns false when no such PENDING invite exists in the org — which
 * covers "wrong org", "already accepted" and "already revoked" alike, so a caller's 404 does not
 * leak whether the id exists in another tenant.
 *
 * An UPDATE rather than a DELETE on purpose: the 0016-shaped restrictive policy makes a blocked
 * UPDATE loud (`WITH CHECK`) while a blocked DELETE is an unavoidably silent `DELETE 0`.
 */
export async function revokeInvite(
  db: DbClient,
  orgId: string,
  inviteId: string,
): Promise<boolean> {
  const rows = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invites.id, inviteId),
        eq(invites.orgId, orgId),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
      ),
    )
    .returning({ id: invites.id });
  return rows.length > 0;
}

/** True when the org already has a PENDING invite for this email (so the route can 409). */
export async function findPendingInviteByEmail(
  db: DbClient,
  orgId: string,
  email: string,
): Promise<InviteRow | undefined> {
  const [row] = await db
    .select(inviteRowColumns)
    .from(invites)
    .where(
      and(
        eq(invites.orgId, orgId),
        eq(invites.email, normalizeEmail(email)),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
      ),
    )
    .limit(1);
  return row;
}
