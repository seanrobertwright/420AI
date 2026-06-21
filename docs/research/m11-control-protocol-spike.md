# M11 Control-Protocol & SEA-Packaging Spike

**Date:** 2026-06-15
**Type:** Throwaway proof-of-concept to de-risk the two M11 design points before planning.
**Builds on:** [`m11-tauri-sidecar-spike.md`](./m11-tauri-sidecar-spike.md) (toolchain/feasibility).
**Verdict:** ✅ **Both design points validated end-to-end. No blockers for the M11 plan.**

> Ratified this session before the spike: **full server-stack supervision** (the app can
> start/stop the local Docker archive + ingest, not just write config) and **JSON-lines over the
> sidecar's stdio** as the UI↔collector control protocol.

---

## What was tested

A throwaway `serve` prototype that **reuses the real collector `QueueStore`** (the genuinely risky
dependency: Node 24's experimental built-in `node:sqlite`) and speaks **newline-delimited JSON over
stdin/stdout**. A `supervisor.mjs` mimicking the Tauri Rust shell spawned it, wrote commands, read
status events, and asserted the round-trip — run **twice**: once under plain `node`, once against a
**standalone `node:sea` `.exe`** with no `node` on the command line.

Protocol shape exercised (the recommended first-cut command/event schema):

- **Commands (UI → sidecar, stdin):** `{cmd:"status"|"pause"|"resume"|"stop"}`
- **Events (sidecar → UI, stdout):** `{type:"ready",pid,db}`, `{type:"status",state,pending,inflight}`,
  `{type:"ack",cmd}`, `{type:"stopped"}`, `{type:"error",...}`

## Results — all PASS

| Question                                                                                                 | Result                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Can the **real collector + `node:sqlite`** be packaged by `node:sea` into a standalone `.exe` that runs? | ✅ Yes. 88 MB artifact (full embedded runtime); durable SQLite queue works inside SEA.                                         |
| Does the **stdio JSON-lines bidirectional protocol** work (control + live status)?                       | ✅ Yes, identical under `node` and the SEA `.exe`. pause holds backlog steady `[2,2]`; resume advances; stop drains + exits 0. |
| Does experimental-module noise pollute the protocol channel?                                             | ✅ No. The `node:sqlite` ExperimentalWarning and the SEA warning go to **stderr**; **stdout stays pure JSON-lines**.           |

## Findings that shape the plan

1. **`node:sqlite` needs NO runtime flag in Node 24.16** — `require('node:sqlite')` works flag-free,
   so the SEA `.exe` needs no `--experimental-*` injection (which SEA makes awkward anyway). This was
   the single biggest packaging unknown; it's resolved.
2. **stderr/stdout discipline is the load-bearing rule for the protocol.** The control channel is
   stdout-only JSON-lines; **all logging/warnings must go to stderr.** A library that writes to stdout
   (forbidden by the project's logging convention anyway) would corrupt the stream — the convention and
   the protocol reinforce each other. The collector's existing `logger` callback should map to stderr
   (or to a `{type:"log"}` event), never raw stdout.
3. **The SEA entry must explicitly call `main()`.** `cli.ts`'s `isMain()` guard
   (`realpathSync(argv[1]) === realpathSync(import.meta.url)`) does **not** fire in a bundled/SEA
   context — the bundled `collector queue` ran but printed nothing because `main()` never executed. M11
   needs a dedicated **`serve`/`daemon` entry** (the stdio protocol loop) as the SEA `main`, distinct
   from the CLI's argv dispatch. This is desirable regardless: the sidecar is a long-running protocol
   server, not an argv one-shot.
4. **Package the sidecar by bundling from TS source, not the composite `dist`.**
   `esbuild apps/collector/src/cli.ts --bundle --platform=node --format=cjs --external:node:*` produced
   a clean 64 KB CJS bundle in one step (resolves the `@420ai/shared` workspace dep + strips TS).
   Bundling the composite `tsc -b` `dist` output failed to resolve a sibling — so the build step should
   be **esbuild-from-source → CJS → `node:sea`**, not `tsc` → SEA.

## Reproducible build recipe (validated)

```
esbuild <serve-entry>.ts --bundle --platform=node --format=cjs --target=node24 --external:node:* --outfile=collector.cjs
# sea-config.json: { "main":"collector.cjs", "output":"sea-prep.blob", "disableExperimentalSEAWarning":true }
node --experimental-sea-config sea-config.json
copy node.exe -> collector-x86_64-pc-windows-msvc.exe        # Tauri sidecar naming (-$TARGET_TRIPLE)
postject <exe> NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

(`postject` is the only new build-time dep, `--no-save` / devDependency; not shipped at runtime.
The "signature seems corrupted" warning on Windows is expected when patching the signed `node.exe`.)

## Notes for the full server-supervision decision (chosen)

The spike did **not** build Docker control (out of its scope), but supervising the archive stack is
mechanically the same shape as supervising the sidecar: a Rust-owned child process with start/stop +
health polling. The risk there is **operational** (assuming a same-machine server; surfacing
`docker compose` failures; not leaving zombies on app quit), not technical-feasibility. The plan
should: own lifecycle in Rust, kill children on app exit, restart-with-backoff, and surface health in
the tray — mirroring the sidecar supervision the spike validated.

## Cleanup

The throwaway prototype (`~/m11-spike/`) was deleted after the run. This doc is the artifact.
