import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchKnowledge } from "@/services/chat/rag-context.service";
import { env } from "@/config/env";

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
    const results = await searchKnowledge(query, topK ?? env.RAG_TOP_K);
    return { results };
  },
});
