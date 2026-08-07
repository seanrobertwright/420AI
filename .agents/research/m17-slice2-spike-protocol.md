# M17 slice 17.2 — real-hardware spike protocol

Written by slice **17.0** (2026-08-07), executed by slice **17.2** the day hardware exists. It
mirrors the timed clean-room deploy of 16.0 ([`cleanroom-2026-08-02.md`](./cleanroom-2026-08-02.md))
on three targets the product has never once run on: **Intel Mac (x86_64-apple-darwin)**,
**Linux x86_64 (x86_64-unknown-linux-gnu)** and **Linux arm64 (aarch64-unknown-linux-gnu)**. An
Apple Silicon Mac, if available, is a bonus fourth target using the Intel Mac's script verbatim.

> **D-M17-5: this spike MEASURES; it does not fix.** Every finding lands as an entry in
> [`incidents.md`](./incidents.md) (severity + category per §4.4, same shape as INC-2026-01…07) and
> is left standing; 17.2's output re-scores slices 17.3–17.6 before any of them is planned. The one
> standing exception, carried over from 16.0's D-16.0-2: **a defect in the isolation the
> measurement itself depends on may be repaired in place** (an unisolated run contaminates real
> state and invalidates its own evidence) — and the defect is still recorded as an incident even
> when repaired.

---

## What 17.0's CI matrix already answered — do not re-measure it

The `cross-platform.yml` matrix already runs the root typecheck, the unit-test layer and
`cargo check` of the Tauri crate on all five runner lanes on every PR. 17.2 is for what CI
structurally **cannot** see:

- Real capture: does a collector on this OS discover, parse and sync a real session file?
- Filesystem semantics: case-sensitivity, path separators, `homedir()` shape, xattrs.
- OS trust machinery: macOS **Gatekeeper** against an unsigned, unnotarized bundle.
- Human-scale timings on the documented path, not runner-scale timings on `npm ci`.

## Known caveat to carry into every run — the Cursor connector ignores `--home`

**INC-2026-01 is open as of this writing:** `--home <dir>` does **not** scope the Cursor poll
connector — it reads the operator's real store via an environment variable, so an "isolated"
collector silently ingests real Cursor history. Slice **17.1** is scheduled to fix exactly this
class before 17.2 runs.

- **If 17.1 has landed:** verify it here — run `collector discover --home <cleanroom>` and assert
  the Cursor source path printed is **under** the clean-room home.
- **If 17.1 has NOT landed:** either disable/ignore the Cursor connector for the run, or record
  every Cursor observation as **downstream of a known isolation breach** — never as a clean
  measurement. (On the Linux boxes Cursor is likely absent, which makes the caveat moot there;
  confirm rather than assume.)

---

## Per-platform protocol

Run the same sequence on each target. One target per day is fine; do not interleave.

### 0. Pre-flight (record, don't fix)

Record: OS name + version, arch (`uname -sm` / `sw_vers`), Node version present (if any), whether
Docker/Postgres is available, disk free, and whether the machine has ever had dev tooling on it. A
truly clean machine is better evidence than a developer workstation — say which one this is.

### 1. Isolation setup

Same four constraints as 16.0's table, plus the lesson its two breaches taught (enumerate the ways
state is SHARED, not just the resources you can see):

| Constraint              | How                                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| Separate checkout       | Clone into a throwaway dir outside any cloud-synced folder                     |
| Separate database       | A fresh Postgres instance or database — and remember INC-2026-06: **roles are cluster-wide**, so a shared instance still shares roles |
| Separate collector home | Every collector call takes `--home <cleanroom-home>`                           |
| Separate ports          | Non-default ingest + dashboard ports                                           |

Then verify the isolation holds **before** trusting anything downstream of it: after the first
`collector discover`, check that every printed source path is under the clean-room home (this is
the INC-2026-01 check above), and snapshot mtimes of the real `~/.420ai/` (if one exists) to
compare at teardown.

### 2. The measured sequence

Follow [`docs/guide/quickstart.md`](../../docs/guide/quickstart.md) **verbatim**, timing each step
with a stopwatch, exactly as 16.0 did. Where the guide breaks, record the break as an incident and
the workaround as a deviation — do not silently improve the path. The collector-side core, per
platform:

```sh
git clone <repo> && cd <repo>
npm ci                                  # time it; record cold vs warm cache
npm run typecheck                       # expect green (CI already proves this — a red here is a finding about the MACHINE)
npx vitest run                          # record passed/skipped counts vs the 17.0 table
node scripts/sidecar-stub.mjs           # then: cargo check in apps/desktop/src-tauri (needs a Rust toolchain)
node apps/collector/scripts/build-sea.mjs   # 17.3 may have un-pinned the triple by now; if not, THIS FAILING ON A NON-WINDOWS TRIPLE IS THE EXPECTED FINDING, record and move on
# pair against the archive, then:
<collector> discover --home <cleanroom-home>
<collector> watch --home <cleanroom-home>     # seed one real session file; verify it arrives in the archive
```

### 3. Timings to record (per platform, one table)

| Measure                                     | Value | Notes                        |
| ------------------------------------------- | ----- | ---------------------------- |
| `npm ci` (state cold/warm)                  |       |                              |
| Root typecheck                              |       |                              |
| `npx vitest run` (passed \| skipped)        |       | compare to 17.0's CI numbers |
| `cargo check` (stub sidecar)                |       |                              |
| SEA sidecar build (if attempted)            |       | expected to fail pre-17.3    |
| Pairing → first verified capture            |       | the §5.2 north-star measure  |
| Steps requiring undocumented intervention   |       | count, list each             |
| Incidents raised                            |       | link IDs                     |

### 4. Evidence to capture

- Full terminal transcripts (script/`tee`) per step — not summaries.
- The collector's `discover` output verbatim (this is the isolation evidence).
- `queue.sqlite` row counts and the archive's raw/event counts before teardown.
- Screenshots only where a GUI is involved (dashboard pairing page; Gatekeeper dialogs below).
- At teardown: the real-state comparison from step 1 (mtimes unchanged, archive machine count
  unchanged), stated explicitly in the report.

---

## Gatekeeper measurement (macOS targets only)

The 420AI bundle is unsigned and unnotarized (code signing is PARKED, D-M17-2). This section
measures what that actually costs a macOS user — it decides whether D-M17-2 holds or must be
reopened, so it must be measured with the fidelity a real user experiences:

1. **Download through a real browser** (Safari, then once more with Chrome). The quarantine
   xattr is applied by the downloading app — **`curl`/`scp` do not set it**, so a copied-over
   bundle silently skips the entire mechanism and measures nothing. Verify the flag is present
   before proceeding: `xattr -p com.apple.quarantine <bundle>`.
2. **Double-click launch.** Record the **exact dialog text** verbatim (screenshot + transcription),
   which buttons exist, and whether the app can be opened from the dialog at all.
3. **Right-click → Open.** Record whether the historical bypass still offers an "Open" button on
   this macOS version, and the exact dialog text if it differs.
4. **System Settings path.** If the current macOS requires Privacy & Security → "Open Anyway",
   record the full click-path and whether it is discoverable without instructions.
5. **Updater behaviour.** If a bundle installs and runs, record whether `tauri-plugin-updater` can
   download and install an unnotarized update over it, or whether the update itself is quarantined
   and blocked. This is a distinct question from first-install and decides whether unsigned macOS
   distribution can self-update at all.
6. Record macOS version explicitly — Gatekeeper behaviour changes across releases, and the finding
   is only valid for the version measured.

Findings land as incidents (category: distribution). "Users cannot realistically open the app" is a
valid, recordable outcome — it re-scores 17.6 and reopens D-M17-2; it is not a reason to start
signing work inside 17.2.

---

## Output artifacts

1. `.agents/research/cleanroom-<platform>-<date>.md` per target, in the shape of
   [`cleanroom-2026-08-02.md`](./cleanroom-2026-08-02.md) — headline result, honesty caveat,
   isolation table, timed step table, incidents list.
2. New entries in [`incidents.md`](./incidents.md) for every finding.
3. A re-score of slices 17.3–17.6 confidence in the milestone plan
   ([`m17-cross-platform-collectors.md`](../plans/m17-cross-platform-collectors.md)), with a
   one-line justification per changed score.
