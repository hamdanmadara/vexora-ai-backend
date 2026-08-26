import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import {
  getIntegrations,
  postRotateWebhook,
  putIntegration,
  removeIntegration,
} from "@/controllers/integrations.controller";

export const integrationsRouter = Router();

integrationsRouter.get("/", asyncHandler(getIntegrations));
integrationsRouter.put("/:provider", asyncHandler(putIntegration));
integrationsRouter.delete("/:provider", asyncHandler(removeIntegration));
integrationsRouter.post(
  "/:provider/rotate-webhook",
  asyncHandler(postRotateWebhook)
);
