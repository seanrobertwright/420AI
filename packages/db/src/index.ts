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
export { machineStatuses, activeSessions } from "./repositories/monitor.js";
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
