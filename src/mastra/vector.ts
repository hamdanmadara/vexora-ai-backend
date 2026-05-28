import { PgVector } from "@mastra/pg";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";
import { logger } from "@/utils/logger";

let _vector: PgVector | null = null;
let _indexReady = false;

export function getVectorStore(): PgVector {
  if (!featureFlags.supabaseReady) {
    throw new FeatureDisabledError("Supabase (PgVector)");
  }
  if (!_vector) {
    _vector = new PgVector({
      id: "vexora-vector",
      connectionString: env.SUPABASE_DB_URL!,
    });
  }
  return _vector;
}

/**
 * Ensures the knowledge index exists. Idempotent — safe to call repeatedly.
 */
export async function ensureKnowledgeIndex(): Promise<void> {
  if (_indexReady) return;
  const store = getVectorStore();
  try {
    await store.createIndex({
      indexName: env.KNOWLEDGE_INDEX_NAME,
      dimension: env.EMBEDDING_DIMENSIONS,
      metric: "cosine",
    });
    _indexReady = true;
    logger.info(
      {
        index: env.KNOWLEDGE_INDEX_NAME,
        dim: env.EMBEDDING_DIMENSIONS,
      },
      "Vector index ready"
    );
  } catch (err) {
    // PgVector's createIndex is idempotent in practice (uses IF NOT EXISTS),
    // but if a race occurs we don't want to crash the request.
    _indexReady = true;
    logger.warn({ err }, "ensureKnowledgeIndex completed with a warning");
  }
}
