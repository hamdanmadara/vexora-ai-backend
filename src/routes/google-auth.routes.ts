import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { requireAuth } from "@/middleware/require-auth";
import {
  googleAuthCallback,
  googleStatus,
  startGoogleAuth,
} from "@/controllers/google-auth.controller";

export const googleAuthRouter = Router();

// /connect and /status belong to the signed-in user (their calendar).
googleAuthRouter.get("/connect", requireAuth, asyncHandler(startGoogleAuth));
googleAuthRouter.get("/status", requireAuth, asyncHandler(googleStatus));

// /callback is Google's redirect — no bearer token possible. The signed
// `state` param proves which user started the flow.
googleAuthRouter.get("/callback", asyncHandler(googleAuthCallback));
