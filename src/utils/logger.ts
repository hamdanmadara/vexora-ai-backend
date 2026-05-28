import pino from "pino";
import { env } from "@/config/env";

const isDev = env.NODE_ENV !== "production";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "vexora-backend" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname,service",
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
