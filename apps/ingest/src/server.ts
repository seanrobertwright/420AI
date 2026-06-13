import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { createDb } from "@420ai/db";
import { buildApp } from "./app.js";

// Load the repo-root .env (this runs from apps/ingest/ via npm -w).
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
if (!adminToken) throw new Error("ADMIN_TOKEN is not set (copy .env.example to .env)");

const { db } = createDb(databaseUrl);
const app = buildApp({ db, adminToken });

await app.listen({ port: Number(process.env.INGEST_PORT ?? 8420), host: "0.0.0.0" });
