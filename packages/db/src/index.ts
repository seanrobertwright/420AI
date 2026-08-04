// Public surface of the archive data layer (@420ai/db).
export * as schema from "./schema.js";
export {
  organizations,
  memberships,
  users,
  machines,
  pairingCodes,
  // M15 15.5 identity core: an org-owned invitation and an identity-owned reset token.
  invites,
  passwordResetTokens,
  // M15 15.6: a stateful user session (D-M15-12). Identity-owned — no org_id, no RLS.
  sessions,
  // M15 15.7: a linked external identity (D-M15-5). Identity-owned — no org_id, no RLS.
  ssoIdentities,
  // M15 15.8: TOTP credentials + recovery codes (D-M15-5). Identity-owned — no org_id, no RLS.
  totpCredentials,
  mfaRecoveryCodes,
  // M15 15.9: a named, hashed, revocable API key (D-M15-7). Identity-owned — no org_id, no RLS.
  apiKeys,
  // M15 15.10: the append-only audit trail (D-15.10-2). Org-owned, but write-only to the app role.
  auditEvents,
  // M16 16.1: the §4.3 outcome label + its immutable revision snapshots (D-16.1-1). STRICT tenant
  // tables — org-owned, read and written per-tenant, unlike `auditEvents` above.
  outcomeLabels,
  outcomeLabelRevisions,
  ingestTokens,
  rawSourceRecords,
  events,
  projects,
  projectGrants,
  workspaces,
  workspaceKeys,
  reportArtifacts,
  gitCommits,
  gitCommitFiles,
  sessionGitLinks,
  machineHeartbeats,
  alertFirings,
  ingestAuthFailures,
  pricingCatalogs,
  connectorCatalogs,
} from "./schema.js";
export { createDb } from "./client.js";
export type { Db, Tx, DbClient } from "./client.js";
export { withOrg, APP_ROLE_NAME, ORG_SETTING, ROLE_SETTING } from "./org-context.js";
export { provisionAppRole } from "./provision-app-role.js";
export { encryptField, decryptField, activeKeyId } from "./crypto.js";
export type { EncryptedField } from "./crypto.js";
export { API_KEY_PREFIX, generateToken, hashToken } from "./tokens.js";
export { runMigrations } from "./migrate.js";
export { createPairingCode, redeemPairingCode, PairingError } from "./repositories/pairing.js";
export {
  createMachine,
  touchLastSeen,
  getMachineUserId,
  getMachineOrgId,
  recordHeartbeat,
} from "./repositories/machines.js";
export {
  ensurePersonalOrg,
  getOrgIdForUser,
  findOrgIdByUserId,
  listOrganizations,
  // M15 15.5: the invite preview names the org an invitee is about to join.
  getOrgName,
  // M15 15.10: the org settings surface. `renameOrg` is owner-gated at the route.
  getOrg,
  // Locked variant, for the rename's read-then-write only (see its comment).
  getOrgForUpdate,
  renameOrg,
} from "./repositories/organizations.js";
export type { OrgRow } from "./repositories/organizations.js";
// M15 15.9: `findPrincipalByUserId` is the same resolution keyed by user id, for the API-key tier
// which already holds one. Its ORDER BY is byte-identical to the email variant on purpose.
export { findPrincipalByEmail, findPrincipalByUserId } from "./repositories/principal.js";
export type { Principal } from "./repositories/principal.js";
export { machineStatuses, activeSessions, recentBacklogSamples } from "./repositories/monitor.js";
export {
  reconcileAlertFirings,
  listAlertFirings,
  ackAlertFiring,
  deliverPendingFirings,
  deliverResolvedFirings,
} from "./repositories/alert-firings.js";
export { recordIngestAuthFailure, countRecentAuthFailures } from "./repositories/auth-failures.js";
export {
  findUserIdByEmail,
  ensureUserByEmail,
  findAdminCredential,
  setUserPassword,
  // M15 15.5 (D-15.5-3): THE email boundary. Every path that keys on an email normalizes here.
  normalizeEmail,
  // M15 15.5 (GOTCHA-1): creates a user WITHOUT a personal org — the invite-accept path's insert.
  createUserWithPassword,
  // M15 15.7: the SSO-only sibling — no password hash, and no personal org either (same reason).
  createUserWithoutPassword,
  // M15 15.7: the inverse of findUserIdByEmail — an SSO login resolved by (provider, subject)
  // knows only a userId, and the session token is signed with the email.
  findUserEmailById,
  // M15 15.8: the id-keyed sibling of findAdminCredential. An MFA challenge names a userId (the one
  // identifier that cannot change between the two login steps), and the verify path re-reads the
  // credential under the SAME `FOR SHARE` lock the 15.6 login takes.
  findCredentialById,
  updatePasswordHash,
} from "./repositories/users.js";
// M15 15.5 organization invitations (D-M15-5). Same lifecycle as `pairing_codes`; unlike it, an
// invite GRANTS PRIVILEGE, hence the 15.4 restrictive role-write policies on the table.
export {
  createInvite,
  findInviteByToken,
  acceptInvite,
  listInvites,
  revokeInvite,
  findPendingInviteByEmail,
  InviteError,
} from "./repositories/invites.js";
export type { InviteRow } from "./repositories/invites.js";
// M15 15.5 single-use password-reset tokens (D-M15-5). An IDENTITY table — no org_id, no RLS.
export {
  createPasswordReset,
  consumePasswordReset,
  PasswordResetError,
} from "./repositories/password-resets.js";
// M15 15.6 stateful sessions (D-M15-12). An IDENTITY table — no org_id, no RLS — so nothing here
// takes an `orgId`; `userId` is the second parameter wherever scoping is needed.
export {
  createSession,
  findLiveSession,
  // M15 15.8: the age of the CURRENT session, for the one re-auth gate that cannot ask for a
  // password (an SSO-only account enrolling MFA).
  findLiveSessionCreatedAt,
  listSessions,
  revokeAllSessions,
  revokeSession,
} from "./repositories/sessions.js";
export type { SessionRow } from "./repositories/sessions.js";
// M15 15.9 API keys (D-M15-7) — the third credential tier, and the one that retires ADMIN_TOKEN.
// An IDENTITY table on the same terms as `sessions`: no org_id, no RLS, so nothing here takes an
// `orgId` and `userId` is the second parameter wherever scoping is needed.
export {
  createApiKey,
  // The GUARDED mint the route uses: per-user cap (serialised on the owner's `users` row) plus the
  // partial-unique-index name check. `createApiKey` stays the unguarded primitive for seeding.
  mintApiKey,
  countLiveApiKeys,
  findLiveApiKey,
  // Liveness WITHOUT touching last_used_at — for the SSE per-tick re-check, which must not become
  // a per-tick write per connected client (audit B.4).
  isApiKeyLive,
  listApiKeys,
  revokeAllApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed,
} from "./repositories/api-keys.js";
export type { ApiKeyRow, MintRefusal } from "./repositories/api-keys.js";
// M15 15.7 SSO identities. Identity-owned — no org_id, no RLS (D-15.7-3), scoped by userId only.
export {
  findUserIdBySsoIdentity,
  linkSsoIdentity,
  listSsoIdentities,
  unlinkSsoIdentity,
  SsoIdentityError,
} from "./repositories/sso-identities.js";
export type { SsoIdentityRow } from "./repositories/sso-identities.js";
// M15 15.8 MFA: a TOTP credential (secret ENCRYPTED at rest) + single-use recovery codes (HASHED).
// Both tables are identity-owned — no org_id, no RLS (D-15.8-13) — so nothing here takes an `orgId`;
// `userId` is the second parameter everywhere.
export {
  findTotpCredential,
  upsertUnconfirmedTotp,
  confirmTotp,
  recordTotpUse,
  recordMfaFailure,
  clearMfa,
  replaceRecoveryCodes,
  redeemRecoveryCode,
  countUnusedRecoveryCodes,
  MfaError,
} from "./repositories/mfa.js";
export type { TotpCredential } from "./repositories/mfa.js";
// M15 15.5 org member management. `memberships`/`users` carry NO RLS, so the explicit orgId
// predicate in each of these is the ONLY tenancy boundary — there is no backstop behind it.
export {
  listMembers,
  findMemberByEmail,
  findMemberByUserId,
  setMemberRole,
  removeMember,
  MemberError,
} from "./repositories/members.js";
export type { MemberRow } from "./repositories/members.js";
// M15 15.10 the append-only audit trail. Deliberately ONE export, and deliberately WITHOUT the
// "the orgId predicate is the only boundary" note every other org-owned repository carries here:
// `audit_events` has no read path at all (D-15.10-4), so there is no query to scope. `org_id` is
// written for the break-glass reader's benefit, not for a predicate.
export { recordAuditEvent } from "./repositories/audit.js";
export type { AuditEventInput } from "./repositories/audit.js";
// M16 16.1 the §4.3 outcome labels (research plan §7 P0.2). Two STRICT tenant tables with the
// ordinary 0015/0016 RLS backstop behind the explicit `orgId` predicate every function here
// carries as its SECOND parameter — which matters more than usual because these reads are keyed by
// `session_id`, a connector-supplied globally-scoped string two tenants can share (the 15.2 rule).
//
// Unlike `recordAuditEvent` above there is a real per-tenant READ path here, and a real DELETE
// (D-16.1-6): a label is volunteered human ground truth rather than captured evidence, so it is the
// one object in this archive its author may retract.
export {
  createOutcomeLabel,
  getOutcomeLabel,
  updateOutcomeLabel,
  deleteOutcomeLabel,
  listOutcomeLabels,
  listOutcomeLabelRevisions,
  OutcomeLabelError,
} from "./repositories/outcome-labels.js";
export type {
  OutcomeLabelRow,
  OutcomeLabelRevisionRow,
  CreateOutcomeLabelInput,
  PatchOutcomeLabelInput,
} from "./repositories/outcome-labels.js";
export { issueIngestToken, findMachineIdByToken } from "./repositories/tokens.js";
export { ingestBatch } from "./repositories/ingest.js";
export {
  findOrCreateProjectByRemote,
  createProject,
  listProjects,
  renameProject,
  getProjectName,
  archiveProject,
} from "./repositories/projects.js";
export type { ProjectRow } from "./repositories/projects.js";
// M15 15.4 per-project capability grants (D-15.4-2). Grants ELEVATE, never restrict.
export {
  listProjectGrants,
  grantProjectRole,
  revokeProjectGrant,
  effectiveProjectRole,
} from "./repositories/project-grants.js";
export type { ProjectGrantRow } from "./repositories/project-grants.js";
export {
  upsertWorkspace,
  addWorkspaceKey,
  remapWorkspace,
  listWorkspaces,
  resolveWorkspaceId,
  projectEventSummary,
} from "./repositories/workspaces.js";
export type { WorkspaceRow } from "./repositories/workspaces.js";
export {
  usageTotals,
  usageByModel,
  usageOverTime,
  sessionProjections,
  sessionDetail,
  connectorHealth,
  connectorHealthWindowed,
  projectGitMetadata,
} from "./repositories/projections.js";
export {
  insertReportArtifact,
  getReportArtifact,
  listReportArtifacts,
} from "./repositories/reports.js";
export type { ReportArtifactRow } from "./repositories/reports.js";
export {
  toolStatsByModel,
  failureSeries,
  failedToolBreakdown,
  contextPathSample,
} from "./repositories/report-projections.js";
export type { ContextWasteSample } from "./repositories/report-projections.js";
export { sessionTranscript, DEFAULT_TRANSCRIPT_CAPS } from "./repositories/transcript.js";
export type { TranscriptEntry, TranscriptCaps } from "./repositories/transcript.js";
export { exportEvents, EXPORT_MAX_ROWS } from "./repositories/exports.js";
export type { EventExportRow, EventExportFilters } from "./repositories/exports.js";
export { recordGitCommits, gitCommitsByProject, gitCommitDetail } from "./repositories/git.js";
export type { GitCommitDetail } from "./repositories/git.js";
export {
  sessionModifiedPaths,
  sessionEndTs,
  computeSessionGitSuggestions,
  addManualLink,
  setLinkStatus,
  listProjectLinks,
  projectSessionIds,
} from "./repositories/attribution.js";
export {
  insertPendingCatalog,
  getActiveCatalog,
  listCatalogs,
  approveCatalog,
  rejectCatalog,
  countPendingCatalogs,
} from "./repositories/pricing-catalogs.js";
export type { PricingCatalogRow } from "./repositories/pricing-catalogs.js";
export {
  insertPendingConnectorCatalog,
  getActiveConnectorCatalog,
  listConnectorCatalogs,
  approveConnectorCatalog,
  rejectConnectorCatalog,
  countPendingConnectorCatalogs,
} from "./repositories/connector-catalogs.js";
export type { ConnectorCatalogRow } from "./repositories/connector-catalogs.js";
// M12 search: only the repo functions are surfaced — the `searchDocuments` TABLE
// shares its name with the query fn, so the table stays internal (repo + migration
// reference it via `./schema.js`); the barrel exports the FUNCTION `searchDocuments`.
export {
  rebuildSearchIndex,
  searchDocuments,
  indexSessions,
  indexProjectDoc,
  indexReportDoc,
} from "./repositories/search.js";
export { reencryptAll } from "./repositories/key-rotation.js";
export type { RotationCounts } from "./repositories/key-rotation.js";
export { repriceAll } from "./repositories/reprice.js";
export type { RepriceResult } from "./repositories/reprice.js";
export { reparseAll } from "./repositories/reparse.js";
export type { ReparseResult } from "./repositories/reparse.js";
