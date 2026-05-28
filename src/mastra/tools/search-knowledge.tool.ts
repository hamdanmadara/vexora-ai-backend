import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { embedTexts } from "@/services/document/embedder";
import { ensureKnowledgeIndex, getVectorStore } from "@/mastra/vector";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("The customer question, rewritten to be self-contained."),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("How many chunks to retrieve. Defaults to 5."),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      text: z.string(),
      source: z.string().nullable(),
      documentId: z.string().nullable(),
      score: z.number(),
    })
  ),
});

export const searchKnowledgeTool = createTool({
  id: "search-knowledge-base",
  description:
    "Search the uploaded company documents (product info, pricing, policies, FAQs) " +
    "for passages that answer a customer's question. Always call this tool before " +
    "answering any factual question about the company, product or pricing.",
  inputSchema,
  outputSchema,
  execute: async (inputData) => {
    const { query, topK } = inputData;
    try {
      await ensureKnowledgeIndex();
      const [embedding] = await embedTexts([query]);
      if (!embedding) return { results: [] };

      const store = getVectorStore();
      const hits = await store.query({
        indexName: env.KNOWLEDGE_INDEX_NAME,
        queryVector: embedding,
        topK: topK ?? env.RAG_TOP_K,
      });

      const results = hits.map((h) => {
        const meta = (h.metadata ?? {}) as Record<string, unknown>;
        return {
          text: String(meta.text ?? ""),
          source: typeof meta.source === "string" ? meta.source : null,
          documentId:
            typeof meta.documentId === "string" ? meta.documentId : null,
          score: typeof h.score === "number" ? h.score : 0,
        };
      });
      return { results };
    } catch (err) {
      logger.error({ err, query }, "Knowledge search failed");
      return { results: [] };
    }
  },
});
