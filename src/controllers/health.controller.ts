import type { Request, Response } from "express";
import { env, featureFlags } from "@/config/env";
import {
  isCalendarApiReady,
  isGoogleConnected,
} from "@/services/google/oauth.service";

export async function getHealth(_req: Request, res: Response): Promise<void> {
  const googleOAuthConnected = featureFlags.googleReady
    ? await isGoogleConnected(env.DEFAULT_SALES_REP_ID)
    : false;
  const googleCalendarReady = featureFlags.googleReady
    ? await isCalendarApiReady(env.DEFAULT_SALES_REP_ID)
    : false;

  res.json({
    status: "ok",
    service: "vexora-backend",
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    features: {
      ...featureFlags,
      googleOAuthConnected,
      googleCalendarConnected: googleCalendarReady,
      googleCalendarNeedsReconnect:
        googleOAuthConnected && !googleCalendarReady,
    },
    googleConnectPath: featureFlags.googleReady
      ? "/api/auth/google/connect"
      : null,
  });
}
