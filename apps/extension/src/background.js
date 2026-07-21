// 420AI Chat Capture — background service worker (MV3).
//
// A periodic POLLER (not a content script, not an SSE interceptor): on a 1-minute
// `chrome.alarms` tick it reads claude.ai's OWN authenticated conversation API (using the
// page's same-site cookies, available to a background fetch because claude.ai is in
// `host_permissions`) and forwards the RAW conversation JSON to the collector's localhost
// `push` receiver. The collector normalizes it (via `parseClaudeWire`) — the extension
// stays trivially thin and dependency-free, and the raw conversation stays the sacred,
// re-parseable record (the D-M13-2 lesson).
//
// CONSENT-GATED: captures nothing until `enabled` is checked in the options page AND a
// push token is stored. Every step is wrapped so a failure degrades to a no-op — the alarm
// handler never throws (best-effort, like the collector's capture loops).

const ALARM_NAME = "420ai-poll";
const DEFAULT_COLLECTOR_URL = "http://127.0.0.1:42017";
const CLAUDE_ORIGIN = "https://claude.ai";
const CONNECTOR_ID = "claude-live";
// First-run backfill bound: the newest N conversations, so a fresh install doesn't push a
// whole account at once (subsequent runs are incremental via `lastSyncIso`).
const FIRST_RUN_LIMIT = 10;

/** Read the persisted settings (with sane defaults). */
async function getSettings() {
  const s = await chrome.storage.local.get(["enabled", "token", "collectorUrl", "lastSyncIso"]);
  return {
    enabled: s.enabled === true,
    token: typeof s.token === "string" ? s.token : "",
    collectorUrl: typeof s.collectorUrl === "string" ? s.collectorUrl : DEFAULT_COLLECTOR_URL,
    lastSyncIso: typeof s.lastSyncIso === "string" ? s.lastSyncIso : "",
  };
}

/** A same-site authenticated GET against the claude.ai API (cookies via host_permissions). */
async function claudeGet(path) {
  const res = await fetch(`${CLAUDE_ORIGIN}${path}`, {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`claude GET ${path} → ${res.status}`);
  return res.json();
}

/** POST a batch of raw conversations to the collector's push receiver. */
async function pushConversations(collectorUrl, token, conversations) {
  const res = await fetch(`${collectorUrl}/v1/push`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ connector: CONNECTOR_ID, conversations }),
  });
  if (!res.ok) throw new Error(`push → ${res.status}`);
  return res.json(); // { rawRecords, events }
}

/** The one poll pass. Best-effort: any thrown error is caught by the caller. */
async function pollOnce() {
  const { enabled, token, collectorUrl, lastSyncIso } = await getSettings();
  if (!enabled || !token) return; // consent gate

  // 1. First organization uuid.
  const orgs = await claudeGet("/api/organizations");
  const org = Array.isArray(orgs) && orgs.length > 0 ? orgs[0] : undefined;
  const orgId = org && typeof org.uuid === "string" ? org.uuid : undefined;
  if (!orgId) throw new Error("no organization uuid");

  // 2. Conversation list; select the ones updated since the last sync (or the newest N first run).
  const list = await claudeGet(`/api/organizations/${orgId}/chat_conversations`);
  if (!Array.isArray(list)) throw new Error("conversation list not an array");
  const byUpdatedDesc = [...list]
    .filter((c) => c && typeof c.uuid === "string" && typeof c.updated_at === "string")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const selected = lastSyncIso
    ? byUpdatedDesc.filter((c) => c.updated_at > lastSyncIso)
    : byUpdatedDesc.slice(0, FIRST_RUN_LIMIT);
  if (selected.length === 0) return;

  // 3. Fetch each selected conversation's full detail.
  const conversations = [];
  let maxUpdated = lastSyncIso;
  for (const item of selected) {
    try {
      const detail = await claudeGet(
        `/api/organizations/${orgId}/chat_conversations/${item.uuid}` +
          `?tree=True&rendering_mode=messages&render_all_tools=true`,
      );
      conversations.push(detail);
      if (typeof item.updated_at === "string" && item.updated_at > maxUpdated) {
        maxUpdated = item.updated_at;
      }
    } catch (err) {
      console.warn("[420ai] conversation fetch failed", item.uuid, err);
    }
  }
  if (conversations.length === 0) return;

  // 4. Push the batch; 5. advance the cursor only on success.
  const result = await pushConversations(collectorUrl, token, conversations);
  await chrome.storage.local.set({ lastSyncIso: maxUpdated });
  console.log(
    `[420ai] pushed ${conversations.length} conversation(s) → ` +
      `${result.rawRecords} record(s), ${result.events} event(s)`,
  );
}

/** Alarm/startup entrypoint — never throws (best-effort). */
async function safePoll() {
  try {
    await pollOnce();
  } catch (err) {
    console.warn("[420ai] poll pass failed (will retry next alarm):", err);
  }
}

// Register the 1-minute alarm (Chrome's minimum period) on install and browser startup.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  void safePoll();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  void safePoll();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void safePoll();
});
