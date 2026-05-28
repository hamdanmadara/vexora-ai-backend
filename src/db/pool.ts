import pg from "pg";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";
import { logger } from "@/utils/logger";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!featureFlags.supabaseReady) {
    throw new FeatureDisabledError("Supabase (Postgres)");
  }
  if (!_pool) {
    _pool = new Pool({
      connectionString: env.SUPABASE_DB_URL,
      // Supabase requires SSL but accepts self-signed certs from poolers
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
    });

    // CRITICAL: On Supabase, the default search_path includes the `extensions`
    // schema, and pgvector / pgcrypto live there. When the transaction pooler
    // routes our queries to different physical connections, some may end up
    // resolving `documents` / `leads` to tables Supabase auto-created in the
    // `extensions` schema (because `create extension vector` runs there).
    // That causes writes/reads to land on different schemas — making data
    // "disappear". We pin every connection to `public` so all our tables are
    // unambiguous.
    _pool.on("connect", (client) => {
      client
        .query("set search_path to public")
        .catch((err) =>
          logger.warn({ err }, "Failed to set search_path on new connection")
        );
    });

    _pool.on("error", (err) => {
      logger.error({ err }, "Postgres pool error");
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
