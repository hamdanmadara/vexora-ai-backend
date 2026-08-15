/**
 * Copies SQL migrations into dist/ after `tsc`.
 *
 * tsc only emits .js for .ts inputs, so `dist/db/migrations` would not exist
 * in a production build and runMigrations() would fail with ENOENT — silently,
 * because server.ts catches migration errors so the app can still boot. That
 * made every deployed instance skip migrations entirely.
 */
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "db", "migrations");
const dest = path.join(root, "dist", "db", "migrations");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

console.log(`Copied migrations → ${path.relative(root, dest)}`);
