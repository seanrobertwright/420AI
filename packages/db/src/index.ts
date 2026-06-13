// Public surface of the archive data layer (@420ai/db).
export * as schema from "./schema.js";
export {
  users,
  machines,
  pairingCodes,
  ingestTokens,
  rawSourceRecords,
  events,
} from "./schema.js";
export { createDb } from "./client.js";
export type { Db, Tx, DbClient } from "./client.js";
export { encryptField, decryptField } from "./crypto.js";
export type { EncryptedField } from "./crypto.js";
export { generateToken, hashToken } from "./tokens.js";
export { runMigrations } from "./migrate.js";
export { createPairingCode, redeemPairingCode, PairingError } from "./repositories/pairing.js";
export { createMachine, touchLastSeen } from "./repositories/machines.js";
export { issueIngestToken, findMachineIdByToken } from "./repositories/tokens.js";
export { ingestBatch } from "./repositories/ingest.js";
