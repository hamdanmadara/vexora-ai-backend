import { openai } from "@ai-sdk/openai";
import { env } from "@/config/env";

/**
 * Single source of truth for which OpenAI models we use.
 * Change in .env to swap models without touching code.
 */
export const chatModel = () => openai(env.OPENAI_CHAT_MODEL);
export const schedulerModel = () =>
  openai(env.OPENAI_SCHEDULER_MODEL ?? env.OPENAI_CHAT_MODEL);
export const embeddingModel = () => openai.embedding(env.OPENAI_EMBEDDING_MODEL);
