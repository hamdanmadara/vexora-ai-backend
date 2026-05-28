import { MDocument } from "@mastra/rag";
import { env } from "@/config/env";

export interface Chunk {
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * Split a long document into overlapping chunks suitable for embedding.
 * Uses Mastra's MDocument helper which understands paragraphs/sentences.
 */
export async function chunkDocument(
  text: string,
  meta: Record<string, unknown> = {}
): Promise<Chunk[]> {
  if (!text.trim()) return [];

  const doc = MDocument.fromText(text, meta);
  const chunks = await doc.chunk({
    strategy: "recursive",
    maxSize: env.RAG_CHUNK_SIZE,
    overlap: env.RAG_CHUNK_OVERLAP,
  });

  return chunks
    .map((c) => ({
      text: c.text,
      metadata: c.metadata as Record<string, unknown> | undefined,
    }))
    .filter((c) => c.text.trim().length > 0);
}
