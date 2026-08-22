import { Router } from "express";
import { healthRouter } from "./health.routes";
import { documentsRouter } from "./documents.routes";
import { chatRouter } from "./chat.routes";
import { googleAuthRouter } from "./google-auth.routes";
import { analyticsRouter } from "./analytics.routes";
import { authRouter } from "./auth.routes";
import { requireAuth } from "@/middleware/require-auth";
import { zendeskRouter } from "@/channels/adapters/zendesk/zendesk.routes";

export const apiRouter = Router();

// Public: health probe, auth itself, and the Zendesk webhook (verified by
// its own shared secret — Zendesk cannot send a bearer token).
apiRouter.use("/health", healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/channels/zendesk", zendeskRouter);

// Google OAuth: /connect and /status act on the signed-in user; /callback
// arrives from Google's redirect with no Authorization header and is bound
// to the user via the signed state param instead (see google-auth.controller).
apiRouter.use("/auth/google", googleAuthRouter);

// Everything else is workspace data — bearer token required.
apiRouter.use("/documents", requireAuth, documentsRouter);
apiRouter.use("/chat", requireAuth, chatRouter);
apiRouter.use("/analytics", requireAuth, analyticsRouter);
