import { Router } from "express";
import { healthRouter } from "./health.routes";
import { documentsRouter } from "./documents.routes";
import { chatRouter } from "./chat.routes";
import { googleAuthRouter } from "./google-auth.routes";
import { analyticsRouter } from "./analytics.routes";
import { authRouter } from "./auth.routes";
import { integrationsRouter } from "./integrations.routes";
import { organizationRouter } from "./organization.routes";
import { platformAdminRouter } from "./platform-admin.routes";
import {
  requireAuth,
  requireOrgAdmin,
  requirePlatformAdmin,
} from "@/middleware/require-auth";
import { requireActiveOrg } from "@/middleware/require-active-org";
import { zendeskRouter } from "@/channels/adapters/zendesk/zendesk.routes";

export const apiRouter = Router();

// Public: health probe, auth itself, and the Zendesk webhook (verified by
// its own shared secret — Zendesk cannot send a bearer token).
apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/channels/zendesk", zendeskRouter);

// Google OAuth: /connect and /status act on the signed-in user's workspace;
// /callback arrives from Google's redirect with no Authorization header and
// is bound to the workspace via the signed state param instead.
apiRouter.use("/auth/google", googleAuthRouter);

// Vexora staff only — not tenant-scoped, so it never sits behind requireActiveOrg.
apiRouter.use("/admin", requireAuth, requirePlatformAdmin, platformAdminRouter);

// Workspace data. requireActiveOrg blocks suspended organizations within
// seconds rather than waiting out the access token.
apiRouter.use("/organization", requireAuth, requireActiveOrg, organizationRouter);
apiRouter.use("/documents", requireAuth, requireActiveOrg, documentsRouter);
apiRouter.use("/chat", requireAuth, requireActiveOrg, chatRouter);
apiRouter.use("/analytics", requireAuth, requireActiveOrg, analyticsRouter);

// Integration credentials are org-admin only (B2C users are admins of their
// own personal org, so they pass without any special-casing).
apiRouter.use(
  "/integrations",
  requireAuth,
  requireActiveOrg,
  requireOrgAdmin,
  integrationsRouter
);
