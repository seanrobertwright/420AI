import type { AuditAction } from "@420ai/shared";
import type { DbClient } from "../client.js";
import { auditEvents } from "../schema.js";

/**
 * M15 15.10 — the audit trail's ONLY repository function, and the file's whole surface.
 *
 * D-15.10-4 — THERE IS NO READER, and that is a decision rather than an omission. The app role
 * reads ZERO rows from `audit_events` (no SELECT policy — see schema.ts and migration 0023), so a
 * `listAuditEvents` added here would compile, run, and return an empty array forever. Adding one
 * therefore requires adding a strict SELECT policy in the SAME commit. `audit.test.ts` asserts this
 * module's export set structurally so the "write-only" claim cannot rot into a half-built list
 * endpoint; `audit.int.test.ts` is the behavioural proof underneath it. Today's read path is
 * break-glass `psql` as the owner (D-M15-7).
 *
 * `DbClient` — a `Db` OR a `Tx` — and here that is load-bearing rather than conventional, because
 * the two kinds of call site need different things:
 *   * `routes/members.ts` / `routes/org.ts` pass the `tx` from their `withOrg` callback;
 *   * `routes/api-keys.ts` / `auth.ts` / `sso.ts` have no org context and pass their own
 *     `app.db.transaction` handle.
 * Both work, because the append-only policy is UNCONDITIONAL (SPIKE checks 1 and 1b).
 *
 * D-15.10-3 — THIS DOES NOT OPEN A TRANSACTION. The caller owns it, and that is exactly what makes
 * the audit row atomic with the action it records: a failed audit insert FAILS THE ACTION. "The
 * change committed but nobody knows who made it" is the worse outcome. Never wrap a call to this in
 * `try/catch` to "protect" the action — CLAUDE.md's standing lesson is that a best-effort/swallow
 * path is the worst place to lose a policy, precisely because it is designed not to complain.
 */

export interface AuditEventInput {
  orgId: string;
  actorUserId: string;
  actorEmail: string;
  /**
   * Typed, not `string`. `audit_events.action` has no CHECK constraint, so this parameter is the
   * whole enforcement — a typo becomes a compile error rather than an unqueryable row in the one
   * table nobody can `UPDATE`.
   */
  action: AuditAction;
  /** Null for `member.invited`: an invited address has no `users` row yet (D-M15-8). */
  targetUserId?: string | null;
  targetEmail?: string | null;
  /**
   * The SHAPE of the change (`{from, to}`, `{revoked: 3}`) — NEVER a token, a token hash, a
   * password or a recovery code. The minted API key's plaintext exists exactly once, in the mint
   * response; echoing it here would create a second, permanent copy in the one table the
   * application cannot delete from.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append one audit row. Returns `void`: the row's id has no consumer (D-15.10-4), and returning one
 * would invite a caller to read it back — which the policy forbids, silently.
 */
export async function recordAuditEvent(db: DbClient, input: AuditEventInput): Promise<void> {
  await db.insert(auditEvents).values({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetEmail: input.targetEmail ?? null,
    metadata: input.metadata ?? null,
  });
}
