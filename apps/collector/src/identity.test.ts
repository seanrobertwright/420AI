import { describe, it, expect, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCredentials,
  saveCredentials,
  requireCredentials,
  NotPairedError,
  type Credentials,
} from "./identity.js";

let dir: string | undefined;

function tmpCredPath(): string {
  dir = mkdtempSync(join(tmpdir(), "m3-identity-"));
  return join(dir, "credentials.json");
}

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    dir = undefined;
  }
});

describe("identity", () => {
  const creds: Credentials = {
    url: "http://localhost:8420",
    token: "tok-abc",
    machineId: "machine-1",
  };

  it("round-trips credentials through save then load", () => {
    const path = tmpCredPath();
    saveCredentials(creds, path);
    expect(loadCredentials(path)).toEqual(creds);
  });

  it("returns undefined when the credentials file is absent", () => {
    const path = tmpCredPath();
    expect(loadCredentials(path)).toBeUndefined();
  });

  it("returns undefined when the credentials file is corrupt JSON", () => {
    const path = tmpCredPath();
    writeFileSync(path, "{ not valid json", "utf8");
    expect(loadCredentials(path)).toBeUndefined();
  });

  it("requireCredentials throws NotPairedError when unpaired", () => {
    const path = tmpCredPath();
    expect(() => requireCredentials(path)).toThrow(NotPairedError);
  });

  it("requireCredentials returns credentials when paired", () => {
    const path = tmpCredPath();
    saveCredentials(creds, path);
    expect(requireCredentials(path)).toEqual(creds);
  });
});
