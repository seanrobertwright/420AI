import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvFiles,
  fillKey,
  generateSecrets,
  setupEnv,
  assertBootValid,
} from "./setup-env.mjs";

// A minimal .env.example stand-in: the three fillable keys plus the longer siblings that must
// NOT be matched by the anchored KEY= replace, plus a required key that keeps its default.
const EXAMPLE = `DATABASE_URL=postgres://420ai:420ai@localhost:5433/420ai
ARCHIVE_ENCRYPTION_KEY=
ARCHIVE_ENCRYPTION_KEYS=
ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=
ADMIN_TOKEN=
SESSION_SECRET=
INGEST_PORT=8420
`;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "setup-env-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fillKey", () => {
  it("fills an empty key without matching a longer sibling key", () => {
    const out = fillKey(EXAMPLE, "ARCHIVE_ENCRYPTION_KEY", "SECRETVAL");
    expect(out).toContain("ARCHIVE_ENCRYPTION_KEY=SECRETVAL");
    // The plural + active-id siblings stay empty (anchored ^KEY= must not spill onto them).
    expect(out).toMatch(/^ARCHIVE_ENCRYPTION_KEYS=$/m);
    expect(out).toMatch(/^ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=$/m);
  });

  it("inserts a value containing a regex-replacement metachar ($) literally", () => {
    // A structurally-significant char for String.replace ($&/$1) embedded in the value: the
    // function-form replacement must emit it verbatim, not interpret it.
    const out = fillKey(EXAMPLE, "ADMIN_TOKEN", "ab$1$&cd");
    expect(out).toContain("ADMIN_TOKEN=ab$1$&cd");
  });

  it("throws when the key is absent (drift guard)", () => {
    expect(() => fillKey("FOO=1\n", "MISSING")).toThrow(/missing the MISSING/);
  });
});

describe("buildEnvFiles", () => {
  it("fills the three secrets and shares SESSION_SECRET with the dashboard file", () => {
    const secrets = { archiveKey: "AK", adminToken: "AT", sessionSecret: "SS" };
    const { env, dashboardEnv } = buildEnvFiles(EXAMPLE, secrets);
    expect(env).toContain("ARCHIVE_ENCRYPTION_KEY=AK");
    expect(env).toContain("ADMIN_TOKEN=AT");
    expect(env).toContain("SESSION_SECRET=SS");
    expect(dashboardEnv).toContain("SESSION_SECRET=SS");
    expect(dashboardEnv).toContain("INGEST_URL=http://localhost:8420");
  });
});

describe("generateSecrets", () => {
  it("produces a 32-byte base64 key and distinct url-safe tokens", () => {
    const s = generateSecrets();
    expect(Buffer.from(s.archiveKey, "base64")).toHaveLength(32);
    expect(s.adminToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.sessionSecret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.adminToken).not.toBe(s.sessionSecret);
  });
});

describe("setupEnv", () => {
  it("generates a boot-valid .env + matching dashboard .env.local, then refuses re-run", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".env.example"), EXAMPLE);

    const { written, envPath, dashboardEnvPath } = setupEnv({ cwd });
    expect(existsSync(envPath)).toBe(true);
    expect(existsSync(dashboardEnvPath)).toBe(true);
    expect(written).toHaveLength(2);

    const env = readFileSync(envPath, "utf8");
    expect(() => assertBootValid(env)).not.toThrow();
    // DATABASE_URL kept its example default (not blanked).
    expect(env).toContain("DATABASE_URL=postgres://420ai:420ai@localhost:5433/420ai");

    // SESSION_SECRET matches across the two files (the D.3 mismatch bug guard).
    const secret = /^SESSION_SECRET=(\S+)$/m.exec(env)?.[1];
    expect(secret).toBeTruthy();
    expect(readFileSync(dashboardEnvPath, "utf8")).toContain(`SESSION_SECRET=${secret}`);

    // Re-run refuses (the A.1 footgun): .env already exists.
    expect(() => setupEnv({ cwd })).toThrow(/already exists/);
  });

  it("does not overwrite an existing dashboard .env.local", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".env.example"), EXAMPLE);
    mkdirSync(join(cwd, "apps", "dashboard"), { recursive: true });
    writeFileSync(join(cwd, "apps", "dashboard", ".env.local"), "INGEST_URL=http://custom\n");

    const { written } = setupEnv({ cwd });
    expect(written).toHaveLength(1); // only .env written
    expect(readFileSync(join(cwd, "apps", "dashboard", ".env.local"), "utf8")).toContain(
      "http://custom",
    );
  });

  it("throws when .env.example is absent", () => {
    const cwd = tmp();
    expect(() => setupEnv({ cwd })).toThrow(/\.env\.example not found/);
  });
});
