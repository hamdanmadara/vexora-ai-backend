import { Router } from "express";
import { healthRouter } from "./health.routes";
import { documentsRouter } from "./documents.routes";
import { chatRouter } from "./chat.routes";
import { googleAuthRouter } from "./google-auth.routes";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/documents", documentsRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/auth/google", googleAuthRouter);
