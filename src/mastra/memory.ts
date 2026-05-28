import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";

let _memory: Memory | null = null;

export function getMemory(): Memory {
  if (!featureFlags.supabaseReady) {
    throw new FeatureDisabledError("Supabase (Memory)");
  }
  if (!_memory) {
    _memory = new Memory({
      storage: new PostgresStore({
        id: "vexora-memory",
        connectionString: env.SUPABASE_DB_URL!,
      }),
      options: {
        // Keep the most recent N messages in context.
        lastMessages: 20,
      },
    });
  }
  return _memory;
}
