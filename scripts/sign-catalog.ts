/**
 * Offline pricing-catalog signer (M10 3d, PRD §10.4/§18). Signs a catalog
 * `{ version, payload }` with the OFFLINE ed25519 private key and prints the
 * `{ version, payload, signature }` body to POST to `POST /v1/catalog`.
 *
 * This is an ENTRYPOINT (CLAUDE.md): it MAY read argv, log, and process.exit. The
 * private key is read ONLY here and NEVER enters the server runtime or the repo.
 * It imports the SAME `canonicalizeCatalog` the server verifies with (D5) — a
 * re-implementation would typecheck but silently fail verification.
 *
 * Usage:
 *   npx tsx scripts/sign-catalog.ts <catalog.json> --key .secrets/catalog-private-key.pem > signed.json
 *   CATALOG_SIGNING_KEY=.secrets/catalog-private-key.pem npx tsx scripts/sign-catalog.ts <catalog.json> > signed.json
 *
 * <catalog.json> is `{ "version": string, "payload": { <model>: ModelPricing } }`.
 */
import { readFileSync } from "node:fs";
import { sign as cryptoSign, createPrivateKey } from "node:crypto";
import { canonicalizeCatalog } from "../packages/shared/src/catalog-signing.js";

function fail(msg: string): never {
  process.stderr.write(`sign-catalog: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const catalogPath = argv.find((a) => !a.startsWith("--"));
  if (!catalogPath) {
    fail("missing <catalog.json> argument (usage: sign-catalog <catalog.json> --key <pem>)");
  }

  const keyFlagIndex = argv.indexOf("--key");
  const keyPath =
    keyFlagIndex >= 0 ? argv[keyFlagIndex + 1] : process.env.CATALOG_SIGNING_KEY;
  if (!keyPath) {
    fail("no private key: pass --key <pem path> or set $CATALOG_SIGNING_KEY");
  }

  let parsed: { version?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as typeof parsed;
  } catch (err) {
    fail(`cannot read/parse ${catalogPath}: ${(err as Error).message}`);
  }
  if (typeof parsed.version !== "string" || typeof parsed.payload !== "object" || parsed.payload === null) {
    fail("catalog must be { version: string, payload: object }");
  }

  const content = { version: parsed.version, payload: parsed.payload as Record<string, never> };

  let privatePem: string;
  try {
    privatePem = readFileSync(keyPath, "utf8");
  } catch (err) {
    fail(`cannot read private key ${keyPath}: ${(err as Error).message}`);
  }

  let signature: string;
  try {
    signature = cryptoSign(
      null,
      Buffer.from(canonicalizeCatalog(content), "utf8"),
      createPrivateKey(privatePem),
    ).toString("base64");
  } catch (err) {
    fail(`signing failed: ${(err as Error).message}`);
  }

  process.stdout.write(JSON.stringify({ ...content, signature }, null, 2) + "\n");
}

main();
