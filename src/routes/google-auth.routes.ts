import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import {
  googleAuthCallback,
  googleStatus,
  startGoogleAuth,
} from "@/controllers/google-auth.controller";

export const googleAuthRouter = Router();

googleAuthRouter.get("/connect", asyncHandler(startGoogleAuth));
googleAuthRouter.get("/callback", asyncHandler(googleAuthCallback));
googleAuthRouter.get("/status", asyncHandler(googleStatus));
