import { createApp } from "@/app";
import { env, featureFlags } from "@/config/env";
import { logger } from "@/utils/logger";
import { runMigrations } from "@/db/migrate";
import { closePool } from "@/db/pool";
import { recoverPendingDocuments } from "@/services/document/document.service";
import { registerAdapter } from "@/channels/channel-manager";
import { zendeskAdapter } from "@/channels/adapters/zendesk/zendesk.adapter";

async function bootstrap(): Promise<void> {
  if (featureFlags.zendeskReady) {
    registerAdapter(zendeskAdapter);
    logger.info("Zendesk channel adapter registered");
  } else {
    logger.warn(
      "Zendesk env not set — /api/channels/zendesk/webhook will respond 503. Set ZENDESK_* vars to enable it."
    );
  }

  if (featureFlags.supabaseReady) {
    try {
      await runMigrations();
    } catch (err) {
      logger.error({ err }, "Database migrations failed");
      // Continue booting — the /health endpoint will still work and tell
      // the operator what's wrong.
    }

    try {
      const recovered = await recoverPendingDocuments();
      if (recovered > 0) {
        logger.warn(
          { count: recovered },
          "Marked stuck pending documents as failed (server was likely restarted mid-ingestion)"
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to recover pending documents");
    }
  } else {
    logger.warn(
      "Supabase env not set — skipping migrations. Set SUPABASE_DB_URL to enable RAG, memory, and scheduling."
    );
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        features: featureFlags,
      },
      `Vexora backend ready → http://localhost:${env.PORT}`
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down…");
    server.close(() => logger.info("HTTP server closed"));
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });
}

void bootstrap();
