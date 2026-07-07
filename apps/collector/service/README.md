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
