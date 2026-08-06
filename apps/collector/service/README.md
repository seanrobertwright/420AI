# Run the collector as a Windows service (WinSW)

Runs `collector watch` as an always-on Windows service: starts at boot **without a login**, restarts
on crash, and stops gracefully (drains the queue). This is the headless alternative to the desktop
app's "Run on login" — pick **one**, never both (two collectors on the same `queue.sqlite` corrupt
each other's backlog).

## Why `--home` matters here

A Windows service runs under a service account. Under **LocalSystem**, Node's `os.homedir()` is
`C:\Windows\System32\config\systemprofile` — **not** your user profile. Without an override the
collector would look there for `~/.claude` / `~/.codex` / `~/.gemini`, your paired
`~/.420ai/credentials.json`, and `queue.sqlite`, find nothing, report "not paired," and silently
capture zero sessions.

`collector watch --home "C:\Users\<you>"` repoints **all three** (sessions, credentials, queue) at
your real profile. LocalSystem has read/write access to user-profile folders by default, so this
works without storing a password. (Least-privilege alternative: run the service _as your user
account_ — then no `--home` is needed; see "Run as your user" below.)

## Prerequisites

1. **Build the collector binary** (self-contained, no Node needed on the box):
   ```powershell
   npm run build:collector-sea
   ```
   Output: `apps\desktop\src-tauri\binaries\collector-x86_64-pc-windows-msvc.exe`.
   (Or reuse the one the desktop installer placed at `%LOCALAPPDATA%\420AI Collector\collector.exe`.)
2. **Pair as your user** (so credentials land in _your_ profile, where the service will read them):
   ```powershell
   collector.exe pair <CODE> --url http://localhost:8420 --name "this-pc"
   ```
   Verify: `Get-Content $HOME\.420ai\credentials.json`.

## Install

1. **Download WinSW** (`WinSW-x64.exe`) from <https://github.com/winsw/winsw/releases>.
2. In this `service\` folder, place **three** files with matching basenames:
   - `420ai-collector.exe` ← the downloaded WinSW binary, **renamed** (WinSW requires the exe and
     `.xml` share a name)
   - `420ai-collector.xml` ← the config in this folder
   - `collector.exe` ← copy of the SEA binary from step 1 (the `.xml` points at `%BASE%\collector.exe`)
3. **Edit `420ai-collector.xml`**: replace `C:\Users\YOURNAME` in the `<arguments>` line with your
   profile path.
4. Install and start (run PowerShell **as Administrator**):
   ```powershell
   .\420ai-collector.exe install
   .\420ai-collector.exe start
   .\420ai-collector.exe status
   ```

## Operate

```powershell
.\420ai-collector.exe stop        # graceful: Ctrl-C → bounded drain, then exit
.\420ai-collector.exe restart
.\420ai-collector.exe uninstall   # stop + remove the service
```

Logs roll under this folder as `420ai-collector.out.log` / `.err.log`. Confirm capture is flowing:

```powershell
.\collector.exe queue --home "C:\Users\YOURNAME"     # pending=N, inflight=M
```

## When capture stops: the fault record and the restart (M16 16.6)

Until M16 16.6 `collector watch` exited **0** no matter why it stopped. A revoked token therefore
looked exactly like a deliberate `stop`: WinSW's `<onfailure action="restart"/>` fires only on a
**non-zero** exit, so Windows recorded no failure, attempted no restart, and Service Manager simply
showed "Stopped". That is how INC-2026-07 ran dead for ~8 days with 159,828 items stranded in the
queue and nothing anywhere reporting it.

Now:

- A **fatal 401** (the archive rejected this machine's token — usually a re-paired, deleted, or
  reset archive) makes `collector watch` write the reason to stderr and exit **1**. WinSW restarts
  per `<onfailure>` and Windows records a service failure in the Event Log.
- The 401 is detected on **any** of the three authenticated requests the collector makes, not just
  the queue upload: the ingest POST, the ~30 s **heartbeat**, and the final **shutdown drain**. The
  heartbeat one matters most on a quiet machine — with an empty queue the collector never uploads
  anything, so the heartbeat is the only thing talking to the archive, and a revoked token would
  otherwise go unreported for as long as the machine stayed idle.
- Any **other** heartbeat failure (archive down, network blip, an older archive) is still swallowed
  and capture continues — only a 401 is fatal.
- A **Ctrl-C, `stop`, or `restart`** still exits **0**, so a deliberate stop never restart-loops.
- On **start**, if `fault.json` is already present the collector says so in
  `420ai-collector.out.log` (and the desktop shows it as an error) — so a fault recorded before a
  reboot is not invisible just because the archive is now merely unreachable rather than rejecting
  the token.
- The durable record is `~\.420ai\fault.json` — under the **same profile as `--home`**, i.e.
  `C:\Users\YOURNAME\.420ai\fault.json` for the LocalSystem install above, not the service profile:

  ```powershell
  Get-Content "C:\Users\YOURNAME\.420ai\fault.json"
  ```

  ```json
  {
    "code": "auth_revoked",
    "message": "ingest returned 401 — token revoked. Re-pair needed: `collector pair <code>`. Stopping sync.",
    "since": "2026-08-06T12:00:00.000Z",
    "lastObservedAt": "2026-08-14T09:31:04.220Z",
    "url": "http://localhost:8420"
  }
  ```

  `since` is when the outage **started** and `lastObservedAt` when it was last seen — so the pair is
  the outage's duration. `since` deliberately survives restarts: WinSW restarts the collector on
  every non-zero exit, and re-stamping `since` each time would have reported an eight-day
  INC-2026-07 as "started twenty seconds ago". A change of archive URL starts a new clock.

  The record names the archive that rejected the credential and **never contains the token itself**,
  so it is safe to paste into a bug report.

- The signal is **self-resolving**: re-pair with
  `collector.exe pair <CODE> --url … --home "C:\Users\YOURNAME"`, and the first sync that actually
  **delivers queued items** deletes `fault.json`. (An idle, empty-queue drain does not count — it
  never contacts the archive, so it proves nothing.) A file that is still there is a fault that is
  still happening.

Because a restarted service will hit the same 401 and exit 1 again, a repeating restart in the
Event Log is itself the alarm — check `fault.json` first, then `420ai-collector.err.log`.

## Run as your user (least-privilege alternative)

Instead of LocalSystem + `--home`, run the service as your account so `homedir()` is naturally
correct (then you can drop `--home` from `<arguments>`):

```powershell
.\420ai-collector.exe install
# Services → "420AI Collector" → Properties → Log On → "This account" → .\<you> + password
# (or: sc.exe config 420ai-collector obj= ".\<you>" password= "<password>")
.\420ai-collector.exe start
```

Note: a user-account service still starts at boot, but file access is scoped to that user (tighter
than LocalSystem).

## Notes

- **Don't commit `WinSW-x64.exe` / the renamed wrapper** — it's a third-party binary. Only the `.xml`
  - this README live in the repo.
- The service needs the **ingest API** reachable at the paired `url`. If your archive runs in Docker,
  start it first (`docker compose up -d`) — `delayedAutoStart` already biases the service to start
  after boot-time services settle.
- Updating the collector: `stop`, replace `collector.exe`, `start`. The durable queue persists across
  restarts, so no captured data is lost.
