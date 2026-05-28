import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "./pool";
import { logger } from "@/utils/logger";

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/migrations";

/**
 * Runs all `.sql` files in the migrations directory in lexicographic order.
 * Each file is wrapped in a transaction. Already-applied migrations are
 * tracked in a `_migrations` table.
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    create table if not exists _migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    );
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const existing = await pool.query<{ name: string }>(
      "select name from _migrations where name = $1",
      [file]
    );
    if (existing.rows.length > 0) {
      logger.debug({ file }, "Migration already applied, skipping");
      continue;
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      // ON CONFLICT guards against race conditions when multiple processes
      // boot at the same time (e.g. tsx watch restart + manual run).
      await client.query(
        "insert into _migrations (name) values ($1) on conflict (name) do nothing",
        [file]
      );
      await client.query("commit");
      logger.info({ file }, "Migration applied");
    } catch (err) {
      await client.query("rollback");
      logger.error({ err, file }, "Migration failed");
      throw err;
    } finally {
      client.release();
    }
  }
}
