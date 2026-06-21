/**
 * Offline catalog signer (M10 3d pricing + M12 12.7c connector, PRD §10.4/§18). Signs a
 * catalog `{ version, payload }` with the OFFLINE ed25519 private key and prints the
 * `{ version, payload, signature }` body to POST to the matching endpoint. The signer is
 * PAYLOAD-AGNOSTIC (the same `canonicalizeCatalog` covers any payload) — the only
 * difference between a pricing and a connector catalog is which PRIVATE KEY signs it and
 * which endpoint receives it.
 *
 * This is an ENTRYPOINT (CLAUDE.md): it MAY read argv, log, and process.exit. The
 * private key is read ONLY here and NEVER enters the server runtime or the repo.
 * It imports the SAME `canonicalizeCatalog` the server verifies with (D5) — a
 * re-implementation would typecheck but silently fail verification.
 *
 * Usage (pricing — POST /v1/catalog):
 *   npx tsx scripts/sign-catalog.ts <catalog.json> --key .secrets/catalog-private-key.pem > signed.json
 *   CATALOG_SIGNING_KEY=.secrets/catalog-private-key.pem npx tsx scripts/sign-catalog.ts <catalog.json> > signed.json
 *
 * Usage (connector — POST /v1/connector-catalog):
 *   npx tsx scripts/sign-catalog.ts --connector <connector-catalog.json> --key .secrets/connector-catalog-private-key.pem > signed.json
 *   CONNECTOR_CATALOG_SIGNING_KEY=.secrets/connector-catalog-private-key.pem npx tsx scripts/sign-catalog.ts --connector <connector-catalog.json> > signed.json
 *
 * <catalog.json> is `{ "version": string, "payload": object }` — a pricing payload is a
 * `{ <model>: ModelPricing }` map; a connector payload is `{ "connectors": [ … ] }`.
 */
import { readFileSync } from "node:fs";
import { sign as cryptoSign, createPrivateKey } from "node:crypto";
import { canonicalizeCatalog } from "../packages/shared/src/catalog-signing.js";

const USAGE = `sign-catalog — offline ed25519 catalog signer (pricing + connector)

  pricing:    sign-catalog <catalog.json> --key <pem>           (or $CATALOG_SIGNING_KEY)
  connector:  sign-catalog --connector <catalog.json> --key <pem> (or $CONNECTOR_CATALOG_SIGNING_KEY)

  <catalog.json> = { "version": string, "payload": object }
  Prints { version, payload, signature } to stdout — POST it to /v1/catalog (pricing) or
  /v1/connector-catalog (connector).`;

function fail(msg: string): never {
  process.stderr.write(`sign-catalog: ${msg}\n`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }
  const isConnector = argv.includes("--connector");
  const keyFlagIndex = argv.indexOf("--key");
  // Positional args = non-flags, EXCLUDING the PEM path that follows `--key`.
  const catalogPath = argv.filter((a, i) => !a.startsWith("--") && i !== keyFlagIndex + 1)[0];
  if (!catalogPath) {
    fail("missing <catalog.json> argument (run with --help for usage)");
  }

  const defaultKeyEnv = isConnector
    ? process.env.CONNECTOR_CATALOG_SIGNING_KEY
    : process.env.CATALOG_SIGNING_KEY;
  const keyPath = keyFlagIndex >= 0 ? argv[keyFlagIndex + 1] : defaultKeyEnv;
  if (!keyPath) {
    fail(
      isConnector
        ? "no private key: pass --key <pem path> or set $CONNECTOR_CATALOG_SIGNING_KEY"
        : "no private key: pass --key <pem path> or set $CATALOG_SIGNING_KEY",
    );
  }

  let parsed: { version?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(readFileSync(catalogPath, "utf8")) as typeof parsed;
  } catch (err) {
    fail(`cannot read/parse ${catalogPath}: ${(err as Error).message}`);
  }
  if (
    typeof parsed.version !== "string" ||
    typeof parsed.payload !== "object" ||
    parsed.payload === null
  ) {
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
