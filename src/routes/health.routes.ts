import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { getHealth } from "@/controllers/health.controller";

export const healthRouter = Router();
healthRouter.get("/", asyncHandler(getHealth));
