import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { requireAuth } from "@/middleware/require-auth";
import {
  getMe,
  patchMe,
  postLogin,
  postLogout,
  postRefresh,
  postSignup,
} from "@/controllers/auth.controller";

export const authRouter = Router();

authRouter.post("/signup", asyncHandler(postSignup));
authRouter.post("/login", asyncHandler(postLogin));
authRouter.post("/refresh", asyncHandler(postRefresh));
authRouter.post("/logout", asyncHandler(postLogout));
authRouter.get("/me", requireAuth, asyncHandler(getMe));
authRouter.patch("/me", requireAuth, asyncHandler(patchMe));
