import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import { env } from "@/config/env";
import { apiRouter } from "@/routes";
import { errorHandler, notFoundHandler } from "@/middleware/error-handler";
import { requestLogger } from "@/middleware/request-logger";

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function buildCorsOptions(): CorsOptions {
  const allowList = new Set(env.CORS_ORIGINS);
  const isDev = env.NODE_ENV !== "production";
  return {
    credentials: true,
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin) return cb(null, true);
      if (allowList.has(origin)) return cb(null, true);
      // In dev, accept any localhost port so vite port-shifting (5173 -> 5174 -> ...)
      // never breaks the frontend.
      if (isDev && LOCALHOST_RE.test(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin not allowed: ${origin}`));
    },
  };
}

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  app.use(cors(buildCorsOptions()));

  // `verify` stashes the exact raw bytes on req.rawBody for every request —
  // harmless for routes that don't read it, but required by the Zendesk
  // webhook to verify its HMAC signature (which is computed over the raw
  // body, not the re-serialized parsed object). See
  // src/types/express.d.ts for the rawBody type augmentation.
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  app.use("/api", apiRouter);

  app.get("/", (_req, res) => {
    res.json({
      name: "vexora-backend",
      docs: "/api/health",
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
