import type { Request, Response } from "express";
import { env, featureFlags } from "@/config/env";

/**
 * PUBLIC endpoint: platform-level configuration only.
 *
 * It used to report the Google connection of one hardcoded tenant, which is
 * meaningless once every organization connects its own calendar (and leaked
 * one workspace's state to anonymous callers). Per-workspace status lives at
 * GET /api/auth/google/status, which is authenticated.
 */
export async function getHealth(_req: Request, res: Response): Promise<void> {

  res.json({
    status: "ok",
    service: "vexora-backend",
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    features: { ...featureFlags },
    googleConnectPath: featureFlags.googleReady
      ? "/api/auth/google/connect"
      : null,
  });
}
