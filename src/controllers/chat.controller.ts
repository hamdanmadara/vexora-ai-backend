import type { Request, Response } from "express";
import { z } from "zod";
import {
  generateChat,
  streamChat,
} from "@/services/chat/chat.service";
import {
  getLeadBySession,
  resetLeadForSession,
} from "@/services/lead/lead.service";
import {
  clearSessionChatHistory,
  loadSessionChatHistory,
} from "@/services/chat/chat-history.service";
import { BadRequestError, NotFoundError } from "@/utils/errors";
import { logger } from "@/utils/logger";

const ChatBodySchema = z.object({
  sessionId: z.string().min(1, "sessionId is required"),
  message: z.string().min(1, "message is required").max(4000),
  channel: z.string().optional(),
  stream: z.boolean().optional().default(true),
});

export async function postChat(req: Request, res: Response): Promise<void> {
  const body = ChatBodySchema.parse(req.body);

  if (body.stream === false) {
    const result = await generateChat({
      sessionId: body.sessionId,
      message: body.message,
      channel: body.channel,
    });
    res.json(result);
    return;
  }

  // Server-Sent Events stream
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 15_000);

  const flush = () => {
    const r = res as Response & { flush?: () => void };
    r.flush?.();
  };

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    flush();
  };

  try {
    send("status", { phase: "started" });

    let any = false;
    for await (const chunk of streamChat({
      sessionId: body.sessionId,
      message: body.message,
      channel: body.channel,
    })) {
      any = true;
      send("delta", { content: chunk });
    }
    if (!any) {
      send("delta", {
        content:
          "I’m having trouble responding right now. Please try again in a moment.",
      });
    }
    send("done", { ok: true });
  } catch (err) {
    logger.error({ err }, "Chat stream errored");
    const message = err instanceof Error ? err.message : String(err);
    send("error", { message });
    send("done", { ok: false });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

export async function getChatHistory(
  req: Request<{ sessionId: string }>,
  res: Response
): Promise<void> {
  const sessionId = String(req.params.sessionId ?? "");
  if (!sessionId) throw new BadRequestError("Missing sessionId");

  const lead = await getLeadBySession(sessionId);

  const messages = await loadSessionChatHistory(sessionId);
  res.json({ lead, messages });
}

export async function deleteChatHistory(
  req: Request<{ sessionId: string }>,
  res: Response
): Promise<void> {
  const sessionId = String(req.params.sessionId ?? "");
  if (!sessionId) throw new BadRequestError("Missing sessionId");

  try {
    await clearSessionChatHistory(sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, "Could not clear session chat history");
    throw new NotFoundError("Session not found");
  }

  try {
    await resetLeadForSession(sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, "Could not reset lead for session");
  }

  res.json({ ok: true });
}
