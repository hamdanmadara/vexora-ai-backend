import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import {
  deleteChatHistory,
  getChatHistory,
  postChat,
} from "@/controllers/chat.controller";

export const chatRouter = Router();

chatRouter.post("/", asyncHandler(postChat));
chatRouter.get("/:sessionId", asyncHandler(getChatHistory));
chatRouter.delete("/:sessionId", asyncHandler(deleteChatHistory));
