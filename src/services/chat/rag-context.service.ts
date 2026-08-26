import { embedTexts } from "@/services/document/embedder";
import { ensureKnowledgeIndex, getVectorStore } from "@/mastra/vector";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

export type KnowledgeHit = {
  text: string;
  source: string | null;
  documentId: string | null;
  score: number;
};

const MAX_PASSAGE_CHARS = 900;

/**
 * Vector search over uploaded company documents (shared by tool + chat
 * prefetch). tenantId is MANDATORY isolation: chunks are stored with the
 * owner's tenant in metadata, and every query filters on it — without this,
 * one workspace's bot would answer from another workspace's documents.
 */
export async function searchKnowledge(
  query: string,
  tenantId: string,
  topK?: number
): Promise<KnowledgeHit[]> {
  try {
    await ensureKnowledgeIndex();
    const [embedding] = await embedTexts([query]);
    if (!embedding) return [];

    const store = getVectorStore();
    const hits = await store.query({
      indexName: env.KNOWLEDGE_INDEX_NAME,
      queryVector: embedding,
      topK: topK ?? env.RAG_TOP_K,
      filter: { tenantId },
    });

    return hits.map((h) => {
      const meta = (h.metadata ?? {}) as Record<string, unknown>;
      const raw = String(meta.text ?? "");
      const text =
        raw.length > MAX_PASSAGE_CHARS
          ? `${raw.slice(0, MAX_PASSAGE_CHARS)}…`
          : raw;
      return {
        text,
        source: typeof meta.source === "string" ? meta.source : null,
        documentId:
          typeof meta.documentId === "string" ? meta.documentId : null,
        score: typeof h.score === "number" ? h.score : 0,
      };
    });
  } catch (err) {
    logger.error({ err, query }, "Knowledge search failed");
    return [];
  }
}

/** Format hits for injection into the agent system context. */
export function formatKnowledgeContext(hits: KnowledgeHit[]): string {
  if (hits.length === 0) {
    return "RETRIEVED_KNOWLEDGE: (no matching passages — say you do not have that detail in the docs.)";
  }

  const blocks = hits.map((h, i) => {
    const src = h.source ? ` [${h.source}]` : "";
    return `--- Passage ${i + 1}${src} ---\n${h.text}`;
  });

  return [
    "RETRIEVED_KNOWLEDGE (answer ONLY from these passages — do NOT call search-knowledge-base):",
    ...blocks,
  ].join("\n\n");
}
