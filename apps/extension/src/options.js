// Options page logic — persists settings to chrome.storage.local and offers a
// "Test connection" that POSTs an EMPTY batch to the receiver (proves the token +
// URL without capturing anything).

const DEFAULT_COLLECTOR_URL = "http://127.0.0.1:42017";

const tokenEl = document.getElementById("token");
const urlEl = document.getElementById("collectorUrl");
const enabledEl = document.getElementById("enabled");
const statusEl = document.getElementById("status");

function showStatus(ok, msg) {
  statusEl.textContent = msg;
  statusEl.className = ok ? "ok" : "err";
}

async function load() {
  const s = await chrome.storage.local.get(["enabled", "token", "collectorUrl"]);
  tokenEl.value = typeof s.token === "string" ? s.token : "";
  urlEl.value = typeof s.collectorUrl === "string" ? s.collectorUrl : DEFAULT_COLLECTOR_URL;
  enabledEl.checked = s.enabled === true;
}

async function save() {
  await chrome.storage.local.set({
    token: tokenEl.value.trim(),
    collectorUrl: urlEl.value.trim() || DEFAULT_COLLECTOR_URL,
    enabled: enabledEl.checked,
  });
  showStatus(true, "Saved.");
}

async function test() {
  const token = tokenEl.value.trim();
  const url = urlEl.value.trim() || DEFAULT_COLLECTOR_URL;
  if (!token) {
    showStatus(false, "Enter the push token first.");
    return;
  }
  try {
    const res = await fetch(`${url}/v1/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ connector: "claude-live", conversations: [] }),
    });
    if (res.status === 200) {
      showStatus(true, "Connected — the collector accepted the token.");
    } else if (res.status === 401) {
      showStatus(false, "Rejected (401): the token does not match the collector's.");
    } else {
      showStatus(false, `Unexpected response: ${res.status}.`);
    }
  } catch {
    showStatus(false, `Could not reach the collector at ${url} — is \`collector watch\` running?`);
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
