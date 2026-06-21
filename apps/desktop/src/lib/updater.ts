import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Auto-update via GitHub Releases (slice 12.8c). Checks the configured endpoint once on
 * launch; if an update is offered AND verifies against the baked-in updater pubkey
 * (`plugins.updater.pubkey` in tauri.conf.json), it downloads, installs, and relaunches.
 *
 * `check()` returns null when no newer version is offered, and REJECTS on a signature
 * mismatch / tampered payload — both are handled by the caller swallowing errors, so a
 * failed or offline check never blocks app start (see App.tsx). The verification key is a
 * free minisign-style updater key, NOT an OS Authenticode cert (code signing is parked).
 */
export async function checkForUpdateOnLaunch(): Promise<void> {
  const update = await check();
  if (!update) return;
  await update.downloadAndInstall();
  await relaunch();
}
