import { embedMany } from "ai";
import { embeddingModel } from "@/mastra/model";
import { featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";

/**
 * Embed an array of strings using the configured OpenAI embedding model.
 * Batches automatically via the AI SDK.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!featureFlags.openaiReady) {
    throw new FeatureDisabledError("OpenAI");
  }
  if (texts.length === 0) return [];

  const { embeddings } = await embedMany({
    model: embeddingModel(),
    values: texts,
  });
  return embeddings;
}
