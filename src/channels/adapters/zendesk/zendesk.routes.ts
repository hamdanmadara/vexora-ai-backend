import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { postZendeskWebhook } from "./zendesk.controller";

export const zendeskRouter = Router();

zendeskRouter.post("/webhook", asyncHandler(postZendeskWebhook));
