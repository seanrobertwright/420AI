import type {
  PairRequest,
  PairResponse,
  IngestBatch,
  IngestResponse,
  DiscoverRequest,
  DiscoverResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  GitCaptureRequest,
  GitCaptureResponse,
} from "@420ai/shared";

/**
 * Thin ingest API client over Node 24's global fetch (no runtime dependency).
 * Direct requests that fail loudly on a non-2xx response. Library file: throws,
 * never logs. The M3 sync worker buffers + retries on top of this client.
 */

/**
 * Hard ceiling on any single outbound request (C.8). An UNBOUNDED fetch is the root cause of the
 * `collector watch` Ctrl-C hang: when SIGINT aborts, the engine waits on the in-flight sync POST,
 * and a stalled/half-open archive connection never resolves nor cancels → shutdown hangs forever
 * (the drain's between-calls deadline can't fire while one fetch is stuck). Every request now has a
 * timeout AND honours an external abort signal so SIGINT cancels the in-flight hop immediately.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Per-request controls: an external abort (e.g. SIGINT) and/or a timeout override. */
export interface RequestOptions {
  /** External abort — cancels the request when the daemon stops (SIGINT). */
  signal?: AbortSignal;
  /** Timeout override (ms); defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Build the AbortSignal for a request: always a timeout, combined with any external signal so the
 * request cancels on whichever fires first. A bounded fetch can never hang the collector (C.8).
 */
function requestSignal(opts?: RequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  return opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** A non-2xx HTTP error carrying the status code so callers can branch on it. */
export class IngestHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IngestHttpError";
  }
}

/** True when the error is an HTTP 401 (revoked/invalid token — stop, re-pair). */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof IngestHttpError && err.status === 401;
}

function trimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new IngestHttpError(
      res.status,
      `${what} failed: HTTP ${res.status} ${res.statusText} — ${body}`,
    );
  }
}

export async function postPair(
  baseUrl: string,
  body: PairRequest,
  opts?: RequestOptions,
): Promise<PairResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: requestSignal(opts),
  });
  await expectOk(res, "pair");
  return (await res.json()) as PairResponse;
}

export async function postIngest(
  baseUrl: string,
  token: string,
  batch: IngestBatch,
  opts?: RequestOptions,
): Promise<IngestResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(batch),
    signal: requestSignal(opts),
  });
  await expectOk(res, "ingest");
  return (await res.json()) as IngestResponse;
}

/**
 * POST discovered workspaces to the archive (M5). Machine-authed, like ingest;
 * the server upserts workspaces + auto-creates projects and returns the mappings.
 * Reuses the same fetch + bearer + expectOk shape as `postIngest`.
 */
export async function postDiscover(
  baseUrl: string,
  token: string,
  req: DiscoverRequest,
  opts?: RequestOptions,
): Promise<DiscoverResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/workspaces/discover`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(req),
    signal: requestSignal(opts),
  });
  await expectOk(res, "discover");
  return (await res.json()) as DiscoverResponse;
}

/**
 * POST a collector liveness heartbeat (M9). Machine-authed, like ingest. Reuses the
 * same fetch + bearer + expectOk shape as `postIngest`. Best-effort by contract: the
 * CALLER (maybeSendHeartbeat) swallows failures — a liveness ping is never queued or
 * retried (residual risk e). Throws IngestHttpError on a non-2xx so the caller can log.
 */
export async function postHeartbeat(
  baseUrl: string,
  token: string,
  body: HeartbeatRequest,
  opts?: RequestOptions,
): Promise<HeartbeatResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: requestSignal(opts),
  });
  await expectOk(res, "heartbeat");
  return (await res.json()) as HeartbeatResponse;
}

/**
 * POST captured git commits to the archive (M10). Machine-authed, like ingest;
 * the server records them in `git_commits`/`git_commit_files` (idempotent by SHA)
 * and returns how many NEW commits were inserted. Reuses the same fetch + bearer +
 * expectOk shape as `postDiscover`.
 */
export async function postGit(
  baseUrl: string,
  token: string,
  req: GitCaptureRequest,
  opts?: RequestOptions,
): Promise<GitCaptureResponse> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/git`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(req),
    signal: requestSignal(opts),
  });
  await expectOk(res, "git");
  return (await res.json()) as GitCaptureResponse;
}

/** A project as listed by the admin `GET /v1/projects` endpoint. */
export interface ProjectListItem {
  id: string;
  name: string;
  gitRemote: string | null;
}

/**
 * List projects from the archive (M5). ADMIN-authed (unlike discover, which uses
 * the machine token) — pass the admin token. Reuses the bearer + expectOk shape.
 */
export async function getProjects(
  baseUrl: string,
  token: string,
): Promise<{ projects: ProjectListItem[] }> {
  const res = await fetch(`${trimUrl(baseUrl)}/v1/projects`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: requestSignal(),
  });
  await expectOk(res, "projects");
  return (await res.json()) as { projects: ProjectListItem[] };
}
