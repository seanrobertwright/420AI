import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvFiles,
  fillKey,
  fillPasswordPlaceholder,
  generateSecrets,
  setupEnv,
  assertBootValid,
} from "./setup-env.mjs";

// A minimal .env.example stand-in: the fillable keys plus the longer siblings that must NOT be
// matched by the anchored KEY= replace, plus a required key that keeps its default. M15 15.3
// adds APP_DB_PASSWORD and the two `<password>`-templated app-role URLs.
const EXAMPLE = `DATABASE_URL=postgres://420ai:420ai@localhost:5433/420ai
APP_DB_PASSWORD=
DATABASE_URL_APP=postgres://420ai_app:<password>@localhost:5433/420ai
DATABASE_URL_TEST=postgres://420ai:420ai@localhost:5433/420ai_test
DATABASE_URL_TEST_APP=postgres://420ai_app:<password>@localhost:5433/420ai_test
ARCHIVE_ENCRYPTION_KEY=
ARCHIVE_ENCRYPTION_KEYS=
ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID=
API_KEY=
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
    const out = fillKey(EXAMPLE, "SESSION_SECRET", "ab$1$&cd");
    expect(out).toContain("SESSION_SECRET=ab$1$&cd");
  });

  it("throws when the key is absent (drift guard)", () => {
    expect(() => fillKey("FOO=1\n", "MISSING")).toThrow(/missing the MISSING/);
  });
});

describe("fillPasswordPlaceholder", () => {
  it("replaces EVERY <password> occurrence (both app-role URLs, M15 15.3)", () => {
    const out = fillPasswordPlaceholder(EXAMPLE, "PW");
    expect(out).not.toContain("<password>");
    expect(out).toContain("postgres://420ai_app:PW@localhost:5433/420ai\n");
    expect(out).toContain("postgres://420ai_app:PW@localhost:5433/420ai_test");
  });

  it("inserts a value containing $ metachars literally (split/join, not replace)", () => {
    expect(fillPasswordPlaceholder("x=<password>", "a$&b")).toBe("x=a$&b");
  });

  it("throws when the placeholder is absent (drift guard)", () => {
    expect(() => fillPasswordPlaceholder("FOO=1\n", "PW")).toThrow(/<password> placeholder/);
  });
});

describe("buildEnvFiles", () => {
  it("fills the secrets and shares SESSION_SECRET with the dashboard file", () => {
    const secrets = {
      archiveKey: "AK",
      sessionSecret: "SS",
      appDbPassword: "PW",
    };
    const { env, dashboardEnv } = buildEnvFiles(EXAMPLE, secrets);
    expect(env).toContain("ARCHIVE_ENCRYPTION_KEY=AK");
    expect(env).toContain("SESSION_SECRET=SS");
    expect(dashboardEnv).toContain("SESSION_SECRET=SS");
    expect(dashboardEnv).toContain("INGEST_URL=http://localhost:8420");
  });

  it("M15 15.3: APP_DB_PASSWORD and both app-role URLs carry the SAME password", () => {
    const secrets = {
      archiveKey: "AK",
      sessionSecret: "SS",
      appDbPassword: "PW",
    };
    const { env } = buildEnvFiles(EXAMPLE, secrets);
    expect(env).toContain("APP_DB_PASSWORD=PW");
    // The URLs and the password the provisioning CLI applies must never disagree — a mismatch
    // is a server that boots, connects, and fails every query with an auth error.
    expect(env).toContain("DATABASE_URL_APP=postgres://420ai_app:PW@localhost:5433/420ai");
    expect(env).toContain(
      "DATABASE_URL_TEST_APP=postgres://420ai_app:PW@localhost:5433/420ai_test",
    );
    expect(env).not.toContain("<password>");
  });
});

describe("generateSecrets", () => {
  it("produces a 32-byte base64 key and distinct url-safe tokens", () => {
    const s = generateSecrets();
    expect(Buffer.from(s.archiveKey, "base64")).toHaveLength(32);
    expect(s.sessionSecret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a url-safe app-role password (it is embedded in a postgres:// URL)", () => {
    const s = generateSecrets();
    // base64url only: a `+` or `/` would need percent-escaping inside the connection URL.
    expect(s.appDbPassword).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(s.appDbPassword, "base64url")).toHaveLength(24);
    expect(s.appDbPassword).not.toBe(s.sessionSecret);
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
    // M15 15.3: DATABASE_URL_APP is boot-REQUIRED, so a generated .env must carry a real one
    // — assertBootValid above would have thrown otherwise, but pin the placeholder too.
    expect(env).not.toContain("<password>");

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
