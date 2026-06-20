// Public surface of the archive data layer (@420ai/db).
export * as schema from "./schema.js";
export {
  users,
  machines,
  pairingCodes,
  ingestTokens,
  rawSourceRecords,
  events,
  projects,
  workspaces,
  workspaceKeys,
  reportArtifacts,
  gitCommits,
  gitCommitFiles,
  sessionGitLinks,
  machineHeartbeats,
  alertFirings,
  pricingCatalogs,
} from "./schema.js";
export { createDb } from "./client.js";
export type { Db, Tx, DbClient } from "./client.js";
export { encryptField, decryptField } from "./crypto.js";
export type { EncryptedField } from "./crypto.js";
export { generateToken, hashToken } from "./tokens.js";
export { runMigrations } from "./migrate.js";
export { createPairingCode, redeemPairingCode, PairingError } from "./repositories/pairing.js";
export {
  createMachine,
  touchLastSeen,
  getMachineUserId,
  recordHeartbeat,
} from "./repositories/machines.js";
export { machineStatuses, activeSessions, recentBacklogSamples } from "./repositories/monitor.js";
export {
  reconcileAlertFirings,
  listAlertFirings,
  ackAlertFiring,
} from "./repositories/alert-firings.js";
export { findUserIdByEmail, ensureUserByEmail } from "./repositories/users.js";
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
  projectGitMetadata,
} from "./repositories/projections.js";
export {
  insertReportArtifact,
  getReportArtifact,
  listReportArtifacts,
} from "./repositories/reports.js";
export type { ReportArtifactRow } from "./repositories/reports.js";
export {
  sessionTranscript,
  DEFAULT_TRANSCRIPT_CAPS,
} from "./repositories/transcript.js";
export type { TranscriptEntry, TranscriptCaps } from "./repositories/transcript.js";
export { exportEvents, EXPORT_MAX_ROWS } from "./repositories/exports.js";
export type { EventExportRow, EventExportFilters } from "./repositories/exports.js";
export {
  recordGitCommits,
  gitCommitsByProject,
  gitCommitDetail,
} from "./repositories/git.js";
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
// M12 search: only the repo functions are surfaced — the `searchDocuments` TABLE
// shares its name with the query fn, so the table stays internal (repo + migration
// reference it via `./schema.js`); the barrel exports the FUNCTION `searchDocuments`.
export { rebuildSearchIndex, searchDocuments } from "./repositories/search.js";
