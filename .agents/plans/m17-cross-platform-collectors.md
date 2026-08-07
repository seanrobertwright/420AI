# M17 — Cross-Platform Collectors

> **Milestone definition** — the output of the 2026-08-07 deferral audit + scope conversation
> (the same process that produced M12, M13, M14, M15 and M16). Conventions live in `CLAUDE.md`;
> this links, not re-pastes. Each slice below still goes through the build loop (`SUMMARY.md` §2)
> with its own `/lril:plan-feature` plan.

M17 is the third V2 milestone promoted from the committed-but-unsequenced bucket (PRD §25,
committed 2026-07-21). It was chosen on the same stated criterion as M15 and M16 — _who the next
milestone is for_ — and the answer is the first one in this project's history that is **not a
person the maintainer can watch over the shoulder**:

**Anyone running this on hardware the maintainer does not own.**

That single sentence is the whole shape of the milestone. Every prior milestone could be verified by
running it on the one Windows machine that built it. M17 cannot. The binding constraint is therefore
**verification, not implementation** — and the repo's `skipped ≠ passed` / `bypassed ≠ enforced` /
`passes on fixtures ≠ runs in production` family predicts precisely where this goes wrong: a macOS
code path that typechecks clean and unit-tests green on Windows is the purest form of a skipped layer
reporting green that this repo has yet produced.

---

## Ground truth (reconnaissance, 2026-08-07)

Established by static analysis before any slice was written, so the plan estimates from measurement
rather than intuition. Every claim below carries a `file:line`; anything inferred is marked.

### Already portable — do NOT re-litigate in any slice

- **The watcher polls; it does not use `fs.watch`.** `apps/collector/src/watcher/file-watcher.ts:9-12`
  records the decision and its reason. This makes M17 immune to the entire classic watcher hazard
  list: no inotify limits, no Linux recursive-watch gap, no FSEvents coalescing, no
  `ReadDirectoryChangesW` overflow. The riskiest-sounding subsystem in the milestone is a non-event.
- **`apps/collector/package.json:9-11` declares exactly one runtime dependency** — the workspace
  `@420ai/shared`. Zero third-party, zero native modules, no `node-gyp`, no `postinstall`.
- **SQLite is the Node 24 builtin** (`queue/queue-store.ts:1`, `store/sqlite-store.ts:1`,
  `connectors/cursor-store.ts:1` all `import { DatabaseSync } from "node:sqlite"`).
- **Redaction already matches POSIX homes** — `packages/shared/src/redaction.ts:146` covers
  `/home/` and `/Users/` alongside the Windows form.
- **Path parsing is separator-tolerant** — `packages/shared/src/discovery.ts:64` splits on `/[\\/]/`.
- **Git is invoked without a shell** — `discovery/git-reader.ts:144` uses `execFile("git", [...])`.
- **`reqwest` is on rustls, not native-tls** (`apps/desktop/src-tauri/Cargo.toml:26`).
- **Run-on-login is already cross-platform** — `apps/desktop/src-tauri/src/lib.rs:20-23` registers
  `tauri_plugin_autostart` with `MacosLauncher::LaunchAgent`. Only the doc comment at
  `autostart.rs:1-7` is Windows-specific prose.
- **The full vitest suite already passes on Linux** — both `.github/workflows/pr-checks.yml:13` and
  `repo-health.yml:27` run `ubuntu-latest`. Linux is not a new target so much as an unadvertised one.

### Where it actually breaks

Ranked, from the reconnaissance sweep:

| #   | What                                                     | `file:line`                                                 | Why it breaks                                                                                                        |
| --- | -------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `defaultCursorStorePath()` reads `process.env.APPDATA`    | `connectors/cursor-store.ts:56`                              | Undefined off-Windows → `join("")` yields a **relative** path; the connector polls a nonexistent file relative to CWD |
| 2   | Cursor `poll.sources` discards its `home` arg (INC-2026-01)| `connectors/cursor.ts:331` vs contract at `connector.ts:64-65`| `--home` cannot repoint Cursor on **any** platform, so service/clean-room scoping is inert for it                      |
| 3   | `keyring` compiled `windows-native` only                   | `src-tauri/Cargo.toml:31`                                    | Off-Windows there is no backend; per the crate's own semantics it falls back to a mock that **persists nothing**       |
| 4   | SEA build hardcodes one triple + `.exe`                    | `scripts/build-sea.mjs:32,39`                                | Emits a Windows-named artifact Tauri's `externalBin` cannot match on any other triple                                 |
| 5   | Bundle targets pinned to NSIS                              | `src-tauri/tauri.conf.json:27`                               | `cargo tauri build` emits no installer at all on macOS/Linux                                                          |
| 6   | Updater feed carries only `windows-x86_64`                 | `docs/guide/operations.md:360-368`, `tauri.conf.json:42-45`  | An installed macOS/Linux build's `check()` finds no platform entry → auto-update silently never fires                 |
| 7   | The entire service install is WinSW                        | `apps/collector/service/420ai-collector.xml`, `service/README.md` | No launchd/systemd equivalent exists; roll-by-size logging has **no** launchd counterpart                        |
| 8   | No macOS notarization story exists repo-wide               | absent; policy at `docs/PRD.md:812-813`                      | "Parked" is survivable on Windows (SmartScreen warns once) but Gatekeeper **hard-blocks** an unnotarized download      |
| 9   | ~~CI has never executed on macOS or Windows~~ **RETIRED by 17.0** | `.github/workflows/cross-platform.yml`                | Five-lane matrix now runs typecheck + vitest + `cargo check` on every PR — see "Measured by 17.0" below               |
| 10  | Case-sensitive FS + un-normalized dedup keys               | `watcher/file-watcher.ts:71`                                 | ext4 is case-sensitive where Windows/APFS-default are not; no `toLowerCase()` normalization exists _(impact inferred)_ |

**Second-order effect worth naming**, because it will look like a bug report from users:
`connectors/connector-approvals.ts:85` folds `c.poll.sources(home)` into the capture-surface approval
fingerprint. Because `sources()` ignores `home` but reads `process.env.APPDATA` at call time, that
fingerprint is **environment-dependent rather than argument-dependent** — so every macOS/Linux
install trips the §10.4 capture-surface-change gate and marks Cursor `needs-approval` for no real
reason. Fixing #1 and #2 fixes this; not fixing it makes it a support burden.

### Measured by 17.0 (run 31178775260, PR #82, 2026-08-07) — measurement, not inference

Five standard GitHub-hosted lanes, every push/PR to `main`. All cells below are read from the run:

| Lane                          | typecheck (`tsc -b --force`) | `npx vitest run`             | `cargo check --locked` |
| ----------------------------- | ---------------------------- | ---------------------------- | ---------------------- |
| `ubuntu-latest` (linux-x64)   | ✅ 10 s                      | ✅ 1034 passed \| 680 skipped | ✅ 81 s                |
| `ubuntu-24.04-arm`            | ✅ 10 s                      | ✅ 1034 passed \| 680 skipped | ✅ 76 s                |
| `macos-15-intel`              | ✅ 16 s                      | ✅ 1034 passed \| 680 skipped | ✅ 209 s               |
| `macos-latest` (arm64)        | ✅ 13 s                      | ✅ 1034 passed \| 680 skipped | ✅ 120 s               |
| `windows-latest`              | ✅ 12 s                      | ✅ 1034 passed \| 680 skipped | ✅ 177 s               |

**The 680 skipped are the Postgres-gated `*.int.test.ts` layer (61 files) — `skipped ≠ passed`.**
These lanes have no DB; that layer is proven only by `repo-health.yml` on `ubuntu-latest`. Any
reading of this table as "all platforms fully green" is a misreading.

Two findings from the first (all-red) run, both worth more than the green table:

1. **`apps/desktop/.gitignore` ignored `src-tauri/icons/` wholesale**, so every checkout but the
   authoring machine was missing files `tauri_build` hard-requires — all five lanes failed
   `cargo check` identically (Windows in the winres step on `icon.ico`; Linux/macOS in
   `tauri::generate_context!` on `32x32.png`). Fixed in 17.0 (the five `tauri.conf.json` icons are
   now tracked): this was CI-infrastructure, not product code, and with it broken the matrix could
   measure nothing platform-specific.
2. **The anticipated `keyring` red cell did NOT materialize** — `keyring v3.6.3` compiles clean on
   all five lanes. Row 3 above is therefore a **runtime** concern only (the off-Windows mock
   backend persists nothing); 17.5 still owns it, but no compile barrier exists.

---

## Slices (dependency order)

| #        | Slice                                    | Size | Confidence | Content                                                                                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **17.0** | Truth: CI matrix + spike protocol        | M    | 90%        | Add a `cross-platform.yml` matrix over `{ubuntu-latest, ubuntu-24.04-arm, macos-15-intel, macos-latest (ARM), windows-latest}`; build the Rust/Tauri crate in CI for the first time. Write 17.2's measurement protocol so it runs the day hardware lands. Output is a **table of what is green where**, replacing every inference above with a measurement. **No product code change.** See `.agents/plans/m17-slice0-cross-platform-ci-matrix.md`. |
| **17.1** | Connector portability                    | S–M  | 90%        | Fix #1 (`APPDATA`) and #2 (INC-2026-01) plus the approval-fingerprint knock-on. Audit every `watchGlobs(home)`/`sources(home)` implementation against the `connector.ts` contract. Windows-verifiable today; no hardware needed.                                                                                        |
| **17.2** | **SPIKE** — truth on real hardware       | M    | _n/a_      | Clean-room runs on Intel Mac, Linux x86_64 and Linux arm64, mirroring 16.0's timed deploy. **Measures; fixes nothing** (D-M17-5). Re-scores 17.3–17.6 before any of them is planned.                                                                                                                                   |
| **17.3** | Multi-target SEA build                   | M    | 65% →      | Un-pin `build-sea.mjs`'s triple. SEA copies `process.execPath`, so it is **build-on-target, not cross-compilable** — this slice depends structurally on 17.0's matrix existing.                                                                                                                                        |
| **17.4** | Service install: launchd + systemd        | M    | 75% →      | Port the WinSW definition. The non-zero-exit contract (INC-2026-07) carries over unchanged. Two real gaps, not renames: roll-by-size logging has no launchd equivalent, and launchd cannot express the 5/10/20s backoff ladder.                                                                                          |
| **17.5** | Desktop shell portability                | M    | 60% →      | Per-target `keyring` feature gating; Tauri Linux `webkit2gtk` toolchain; autostart docs corrected to match the already-portable implementation.                                                                                                                                                                        |
| **17.6** | Installers + updater feed + release lane | M–L  | 50% →      | Bundle targets beyond `["nsis"]`; updater feed keys beyond `windows-x86_64`; un-park the CI release workflow (`tauri-action`). Lowest confidence and most spike-dependent.                                                                                                                                             |
| **17.7** | Cross-platform UAT + sign-off            | M    | 85%        | Extend `UAT.md` with per-platform lanes. Sign-off requires each target exercised on the hardware class it claims.                                                                                                                                                                                                      |

`→` marks a confidence score the 17.2 spike is expected to move. Those four slices are
**deliberately not planned in detail yet** — planning them now would be estimating from inference,
which is exactly what 16.0's clean-room deploy proved unreliable.

**Ordering rationale.** 17.0 first because it is the only slice needing no hardware that also
produces real macOS and Windows signal — it converts the reconnaissance table above from inference
into measurement, and it does so while the Mac and Linux boxes are still being set up. 17.1 second
because both its defects are already documented incidents with nothing left to learn from
re-measuring them (D-M17-6), and leaving them in would make every Cursor finding in the spike
downstream of one known bug. 17.2 third, the moment hardware exists. 17.3–17.6 only after the spike
re-scores them. 17.7 last, because it verifies the others.

---

## Decisions

### D-M17-1 — Full parity is the scope

Collector CLI **and** service install **and** desktop shell **and** installers **and** auto-update,
on macOS and Linux. Not a collector-only subset. Chosen deliberately over the smaller scope: a
cross-platform collector that a user must start by hand, and that never updates itself, is not
meaningfully "supported on macOS" — it is a tarball with a README.

### D-M17-2 — Code signing stays PARKED

M12 12.8 parked CA/Authenticode signing and MSI/WiX indefinitely (`docs/PRD.md:812-813`,
`docs/guide/operations.md:335-337`). M17 does **not** un-park them by default. This is only tenable
because Tauri's updater key is its own minisign key, **decoupled from any CA certificate**
(`apps/desktop/src/lib/updater.ts:12`) — so auto-update works unsigned on Windows today.

**The known tension, recorded rather than resolved:** that decoupling does not hold on macOS, where
Gatekeeper hard-blocks an unnotarized download and notarization requires a paid Apple Developer
identity. D-M17-5's spike **measures** what actually happens — quarantine behaviour, whether
right-click-open still works in 2026, whether the Tauri updater can install an unnotarized bundle —
and the decision is revisited then, from evidence. If the spike shows macOS is unusable unsigned,
un-parking macOS signing alone becomes a scope-change proposal, not a silent fix.

### D-M17-3 — Targets: `darwin-x86_64` · `linux-x86_64` · `linux-arm64`, all hardware-verified

Chosen against what can actually be run: an Intel Mac, a Linux VM, and real ARM hardware. Each of the
three is verified on the hardware class it claims.

### D-M17-4 — Apple Silicon ships as a universal binary, CI-verified only

macOS builds emit a **universal** bundle, so Apple Silicon users are not excluded — but ARM is
verified only by free public-repo `macos-latest` runners (build + unit tests), never on hardware.
**This is labelled, not hidden**: release notes and `docs/guide/operations.md` must say
"CI-verified, not hardware-verified" for `darwin-aarch64`. Naming the gap is what distinguishes this
from the skipped-layer failures the repo keeps rediscovering; an unlabelled universal binary would be
a claim of support nobody had checked.

The enabling fact: **the repo is PUBLIC**, so GitHub Actions macOS runners are free and unlimited. On
a private repo macOS bills at 10× and this decision would have to be justified on cost.

### D-M17-5 — Slice 17.2 MEASURES; it does not fix

Inherited wholesale from D-16.0-2, which paid for itself: 16.0's clean-room deploy raised five
incidents, fixed none, and the headline finding (INC-2026-01, a read breach while every write-side
check passed) would have been invisible had the spike been allowed to repair as it went. Every 17.2
finding becomes an `.agents/research/incidents.md` entry that earns a fix in a later slice under the
scope-change rule. Fixing pre-emptively converts evidence into a guess.

**The one standing exception**, also inherited: defects in the isolation the measurement's own safety
constraint depends on may be fixed in-slice, because the spike cannot be trusted without them.

### D-M17-6 — 17.1 lands before the spike, as a bounded exception to D-M17-5

Both Cursor defects are already written down (INC-2026-01 in `.agents/research/incidents.md:150`,
cited in `docs/guide/data-boundary.md:59-62`). Re-measuring a documented incident produces no
evidence, and leaving it in place means every Cursor observation in 17.2 is downstream of one known
bug rather than of the platform. The exception is bounded to these two defects and their
approval-fingerprint knock-on; nothing else is fixed before the spike.

---

## Non-goals (name in every PR; do NOT build here)

- **CA code signing, Authenticode, MSI/WiX** — parked by 12.8, see D-M17-2. macOS notarization is
  in scope only as a **measurement** in 17.2.
- **Windows ARM (`aarch64-pc-windows-msvc`)** — no hardware, no demand, no verification story.
- **Mobile** — the mobile consumption app is M19.
- **Re-architecting the watcher.** It already polls and is already portable
  (`file-watcher.ts:9-12`). Do not "improve" it to `fs.watch`/`chokidar` under cover of this
  milestone; that would trade a working cross-platform property for a Windows-shaped one.
- **New connectors.** M17 makes the existing nine work elsewhere; it adds none.
- **Packaging the dashboard or ingest.** Both are already platform-neutral Node/browser surfaces.

---

## Risks

1. **The spike is calendar-blocked on hardware setup.** The Mac and Linux boxes do not exist yet.
   Mitigation: 17.0 and 17.1 are deliberately hardware-free and sequenced first, so the milestone
   does not idle. Explicitly **not** mitigated by letting the spike slip into CI-only — a
   CI-runner-only spike cannot observe real session files, GUI install, or Gatekeeper.
2. **macOS may prove unusable unsigned** (D-M17-2's tension). Mitigation: measured in 17.2 before
   17.6 is planned, so the discovery lands while the distribution slice is still re-plannable.
3. **Tauri Linux (`webkit2gtk`) toolchain drift** is the least predictable build dependency in the
   stack. Mitigation: 17.0 puts the Rust build in CI on Linux _before_ 17.5 needs it, so the
   toolchain problem surfaces in the cheapest slice rather than the most expensive one.
4. **The maintainer builds and verifies alone**, on hardware chosen to be convenient. Same shape as
   M16 Risk 2. Mitigation: CI runs the matrix on hardware nobody chose, and 17.7's UAT lanes are
   written per-platform so a skipped lane is visible as a skipped lane.
5. **macOS runner-image churn.** GitHub retires macOS images on a rolling schedule, and this already
   bit the plan once: `macos-13` was named here at promotion time and **no longer exists** — verified
   2026-08-07 against `actions/runner-images`, which now lists Intel as `macos-15-intel` /
   `macos-26-intel` and marks the macOS 14 images deprecated. Mitigation: 17.0 pins labels
   explicitly, and 17.7 re-verifies every label against `actions/runner-images` at sign-off rather
   than trusting this document.

**Correction folded in from 17.0 planning (2026-08-07), because it strengthens D-M17-3:**
`ubuntu-24.04-arm` is a **standard** GitHub-hosted runner, and standard runners are free and
unlimited on public repositories — so `linux-arm64` gets **native, free CI** rather than the
cross-compile-and-hope treatment this plan assumed. The Intel macOS labels (`macos-15-intel`) are
standard too, so D-M17-4's "free ARM Mac runners" premise holds for the Intel half as well. Only the
`-large` / `-xlarge` variants are the paid larger-runner tier; **no lane may use them.**

---

## Pre-sign-off checklist (maintainer manual — every box)

- [ ] CI matrix green on all four runner lanes, with the Rust crate built on each.
- [ ] Collector `pair`/`watch`/`sync`/`discover`/`git`/`queue` exercised on **Intel Mac**,
      **Linux x86_64** and **Linux arm64** against real sessions — not fixtures.
- [ ] Service install verified: launchd on macOS, systemd on Linux, WinSW still working on Windows.
      The single-owner constraint (one `queue.sqlite`) re-stated for both new platforms.
- [ ] Desktop app installs, pairs, persists its token **across a restart** on each platform
      (the `keyring` mock-fallback failure is invisible until the second launch).
- [ ] Auto-update performs a real version-to-version upgrade on each platform, or the platform is
      documented as update-unsupported with the reason.
- [ ] `darwin-aarch64` labelled "CI-verified, not hardware-verified" everywhere it is offered.
- [ ] `npm run repo-health -- --require-db` passes.
- [ ] Every 17.2 finding is either fixed in a later slice or carried as an open
      `.agents/research/incidents.md` entry with a stated reason.
