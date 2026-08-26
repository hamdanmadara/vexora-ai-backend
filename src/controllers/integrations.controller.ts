import type { Request, Response } from "express";
import { featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";
import { authOf } from "@/middleware/require-auth";
import {
  deleteIntegration,
  listIntegrations,
  rotateWebhookToken,
  upsertIntegration,
} from "@/services/integrations/integrations.service";
import { PROVIDERS } from "@/services/integrations/providers";

function ensureReady(): void {
  if (!featureFlags.integrationsReady) {
    throw new FeatureDisabledError(
      "Integrations (set CREDENTIALS_ENCRYPTION_KEY)"
    );
  }
}

/**
 * GET /api/integrations — the provider catalog (drives the UI forms) plus
 * this workspace's connections with secrets masked.
 */
export async function getIntegrations(
  req: Request,
  res: Response
): Promise<void> {
  ensureReady();
  const { userId } = authOf(req);
  const connected = await listIntegrations(userId);
  const catalog = Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    webhookTriggers: p.webhookTriggers,
    fields: p.fields,
  }));
  res.json({ catalog, connected });
}

/** PUT /api/integrations/:provider — create or replace (verifies live first). */
export async function putIntegration(
  req: Request<{ provider: string }>,
  res: Response
): Promise<void> {
  ensureReady();
  const { userId } = authOf(req);
  const integration = await upsertIntegration(
    userId,
    String(req.params.provider ?? ""),
    (req.body ?? {}) as Record<string, unknown>
  );
  res.status(201).json({ integration });
}

/** DELETE /api/integrations/:provider */
export async function removeIntegration(
  req: Request<{ provider: string }>,
  res: Response
): Promise<void> {
  ensureReady();
  const { userId } = authOf(req);
  await deleteIntegration(userId, String(req.params.provider ?? ""));
  res.json({ ok: true });
}

/** POST /api/integrations/:provider/rotate-webhook — new URL, old one dies. */
export async function postRotateWebhook(
  req: Request<{ provider: string }>,
  res: Response
): Promise<void> {
  ensureReady();
  const { userId } = authOf(req);
  const integration = await rotateWebhookToken(
    userId,
    String(req.params.provider ?? "")
  );
  res.json({ integration });
}
