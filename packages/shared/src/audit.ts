/**
 * M15 15.10 — the closed set of AUDITED ACTIONS (D-15.10-2/3/4).
 *
 * TEXT, not a pg enum, matching `memberships.role` (schema.ts:87), `ROLES` and every other closed
 * set in this repo — adding a value is a code change, not a migration. The `action` column on
 * `audit_events` carries NO CHECK constraint, so THIS GUARD IS THE ENFORCEMENT: the repository
 * takes an `AuditAction`, which makes a typo a compile error rather than an unqueryable string in
 * the one table the application can never `UPDATE`.
 *
 * The spelling is `<subject>.<verb_past_tense>`, asserted by `audit.test.ts`. Past tense because an
 * audit row records something that HAPPENED — the write is in the same transaction as the action it
 * describes (D-15.10-3), so by the time anyone can read it, it is history.
 *
 * WHAT IS DELIBERATELY EXCLUDED, so the boundary is a decision rather than an oversight:
 *
 *   - LOGINS AND LOGIN FAILURES. `ingest_auth_failures` already records the failures, which is the
 *     half with security value; recording every SUCCESS would turn a record of privileged acts into
 *     a traffic log and bury the ten entries below under one row per page view.
 *   - SELF-SERVICE CREDENTIAL CHANGES a user makes to their OWN account — password change, MFA
 *     enrol/disable, session revoke. They are already visible to the account holder (that is what
 *     `/settings` is), and none of them changes another principal's standing, which is the property
 *     that makes an act audit-worthy here. `member.mfa_reset` IS audited precisely because it is the
 *     admin-initiated variant: someone else acting on your credentials.
 */
export const AUDIT_ACTIONS = [
  "api_key.minted",
  "api_key.revoked",
  "api_key.revoked_all",
  "member.invite_revoked",
  "member.invited",
  "member.joined",
  "member.mfa_reset",
  "member.removed",
  "member.role_changed",
  "org.renamed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Narrowing guard for an action arriving as a bare string (e.g. from a break-glass query). */
export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}
