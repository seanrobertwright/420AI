/**
 * Dashboard-local WIRE types (M12 12.2a). The dashboard depends on `@420ai/shared` ONLY
 * (not `@420ai/db`), so db-origin rows whose server type carries `Date` columns are mirrored
 * here with **`string`** timestamps: JSON-over-HTTP serializes every `Date` to an ISO string,
 * so typing them `Date` and calling `.toISOString()` in the browser is the classic bug this
 * prevents. Shapes match the `@420ai/db` repositories (kept in sync by hand — see the plan's
 * "shared vs db type" gotcha). Projection types with ISO `string` already live in
 * `@420ai/shared` (SessionProjection/UsageTotals/…) and are imported directly there.
 */

import type { ConnectorCatalogPayload } from "@420ai/shared";

/** Mirror of `@420ai/db` ProjectRow (`createdAt`/`archivedAt` are `Date` server-side). */
export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  gitRemote: string | null;
  createdAt: string; // server type is Date
  archivedAt: string | null; // server type is Date | null
}

/** Mirror of `@420ai/db` ReportArtifactRow (`generatedAt` is `Date` server-side). */
export interface ReportArtifactRow {
  id: string;
  userId: string;
  projectId: string | null;
  reportType: string;
  scopeKind: string;
  scopeId: string;
  version: number;
  reportVersion: string;
  catalogVersion: string | null;
  analysisVersion: string | null;
  params: unknown;
  metrics: unknown;
  markdown: string;
  generatedAt: string; // server type is Date
}

/** Mirror of `@420ai/db` WorkspaceRow (`createdAt`/`lastSeenAt` are `Date` server-side). */
export interface WorkspaceRow {
  id: string;
  userId: string;
  projectId: string | null;
  machineId: string | null;
  rootPath: string;
  gitRemote: string | null;
  gitBranch: string | null;
  createdAt: string; // server type is Date
  lastSeenAt: string; // server type is Date
}

/**
 * Mirror of `@420ai/db` `projectEventSummary` return shape (the `GET /v1/projects/:id/summary`
 * body). `lastActivity` is `max(events.ts)` over a `mode:"string"` column → already an ISO
 * string server-side (no Date coercion).
 */
export interface ProjectEventSummary {
  eventCount: number;
  lastActivity: string | null;
}

/**
 * Mirror of `@420ai/db` PricingCatalogRow (pricing-catalogs.ts). Timestamps already arrive as
 * ISO `string` on the wire (the repo normalizes the Date columns on read). `payload` is the
 * signed pricing blob — typed `Record<string, unknown>` here because the dashboard never renders
 * its internals (the catalog surface manages the approval gate only; upload is offline-signed).
 */
export interface PricingCatalogRow {
  id: string;
  version: string;
  payload: Record<string, unknown>;
  signature: string;
  status: "pending" | "active" | "superseded" | "rejected";
  uploadedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
}

/**
 * Mirror of `@420ai/db` ConnectorCatalogRow (connector-catalogs.ts) — the M12 12.7c signed
 * connector catalog's lifecycle row (M14 14.2 surfaces its approval gate). Timestamps are
 * already ISO `string` on the wire (the repo's `toRow` normalizes on read — do not re-coerce).
 * `payload` IS typed (unlike pricing): the view renders the per-catalog entry count.
 */
export interface ConnectorCatalogRow {
  id: string;
  version: string;
  payload: ConnectorCatalogPayload;
  signature: string;
  status: "pending" | "active" | "superseded" | "rejected";
  uploadedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
}
