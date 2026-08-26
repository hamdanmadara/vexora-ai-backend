import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchKnowledge } from "@/services/chat/rag-context.service";
import { getLeadBySession } from "@/services/lead/lead.service";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("The customer question, rewritten to be self-contained."),
  sessionId: z
    .string()
    .min(1)
    .describe(
      "The current chat session id — the agent receives this in its runtime context."
    ),
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
    const { query, sessionId, topK } = inputData;

    // The knowledge base is per-workspace; the session's lead tells us whose.
    // Fail CLOSED: no resolvable tenant → no results, never someone else's.
    const lead = await getLeadBySession(sessionId).catch(() => null);
    if (!lead) {
      logger.warn(
        { sessionId },
        "search-knowledge-base: no lead for session — returning no results"
      );
      return { results: [] };
    }

    const results = await searchKnowledge(
      query,
      lead.tenant_id,
      topK ?? env.RAG_TOP_K
    );
    return { results };
  },
});
