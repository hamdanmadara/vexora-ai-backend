import type { Request, Response } from "express";
import { env } from "@/config/env";
import {
  buildAuthUrl,
  handleOAuthCallback,
  isGoogleConnected,
} from "@/services/google/oauth.service";
import { getGoogleCredentials } from "@/services/google/credentials.service";
import { BadRequestError } from "@/utils/errors";

export async function startGoogleAuth(
  _req: Request,
  res: Response
): Promise<void> {
  const url = buildAuthUrl(env.DEFAULT_SALES_REP_ID);
  res.redirect(url);
}

export async function googleAuthCallback(
  req: Request,
  res: Response
): Promise<void> {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code) throw new BadRequestError("Missing OAuth code");

  const salesRepId = state || env.DEFAULT_SALES_REP_ID;
  const result = await handleOAuthCallback(code, salesRepId);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Google connected</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 40px; max-width: 480px; margin: 40px auto; }
  .ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 16px 20px; border-radius: 12px; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
</style></head><body>
<div class="ok">
  <h2 style="margin:0 0 8px">Google connected!</h2>
  <p style="margin:0">Connected account: <code>${result.email ?? "(unknown)"}</code></p>
  <p>Vexora can now book meetings on this calendar. You can close this tab.</p>
</div>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

export async function googleStatus(
  _req: Request,
  res: Response
): Promise<void> {
  const connected = await isGoogleConnected(env.DEFAULT_SALES_REP_ID);
  const creds = connected
    ? await getGoogleCredentials(env.DEFAULT_SALES_REP_ID)
    : null;
  res.json({
    connected,
    email: creds?.google_email ?? null,
  });
}
