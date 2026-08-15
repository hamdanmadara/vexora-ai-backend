import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import {
  getAiReport,
  getOverview,
  getPeriods,
  postAiReport,
} from "@/controllers/analytics.controller";

export const analyticsRouter = Router();

analyticsRouter.get("/overview", asyncHandler(getOverview));
analyticsRouter.get("/periods", asyncHandler(getPeriods));
analyticsRouter.get("/ai", asyncHandler(getAiReport));
analyticsRouter.post("/ai", asyncHandler(postAiReport));
