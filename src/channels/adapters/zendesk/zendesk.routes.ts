import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import {
  postZendeskWebhook,
  postZendeskWebhookForToken,
} from "./zendesk.controller";

export const zendeskRouter = Router();

// Per-workspace route: the token identifies whose integration this is.
zendeskRouter.post("/webhook/:token", asyncHandler(postZendeskWebhookForToken));

// Legacy env-configured route — kept during the migration to per-user
// integrations; remove once every workspace uses its tokenized URL.
zendeskRouter.post("/webhook", asyncHandler(postZendeskWebhook));
