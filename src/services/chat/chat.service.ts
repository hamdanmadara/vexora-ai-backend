import {
  getOrCreateLead,
  updateLead,
  type LeadRow,
} from "@/services/lead/lead.service";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { isCalendarApiReady } from "@/services/google/oauth.service";
import { routeToAgent } from "./router";
import { extractCustomerText, isInternalStreamText } from "./stream-utils";
import {
  extractContactFromMessage,
  getSchedulingStage,
  isSchedulingMessage,
  mergeContact,
  resolveLeadStatusAfterMessage,
} from "./scheduling-intent";
import {
  bumpUserTurn,
  EXPLICIT_CALL_REQUEST_RE,
  mergeConversationTopic,
  mergeCustomerTimezone,
  mergeMeetingDuration,
  parseLeadMeta,
  serializeLeadMeta,
  shouldKnowledgeOfferCall,
} from "./lead-meta";
import { tryAutoBookMeeting } from "./scheduling-booking";
import { ensureSessionThread } from "./chat-history.service";
import { normalizeAssistantText } from "@/utils/normalizeText";
import { timezoneLabel } from "@/utils/timezone";

export interface ChatTurn {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

function ensureReady(): void {
  if (!featureFlags.openaiReady) {
    throw new FeatureDisabledError("OpenAI");
  }
  if (!featureFlags.supabaseReady) {
    throw new FeatureDisabledError("Supabase");
  }
}

async function buildSystemHint(
  lead: LeadRow,
  meta: ReturnType<typeof parseLeadMeta>,
  schedulingStage: string,
  routedId: string
): Promise<string> {
  const lines = [
    `Runtime context:`,
    `- sessionId: ${lead.session_id}`,
    `- lead.name: ${lead.name ?? "(unknown)"}`,
    `- lead.email: ${lead.email ?? "(unknown)"}`,
    `- lead.status: ${lead.status}`,
    `- customerTurnCount: ${meta.userTurns}`,
    `- mayOfferMeeting: ${routedId === "knowledge" && shouldKnowledgeOfferCall(meta, "")}`,
    `- schedulingStage: ${schedulingStage}`,
    `Pass sessionId to any tool that accepts it.`,
  ];

  if (routedId === "knowledge") {
    lines[6] = `- mayOfferMeeting: ${shouldKnowledgeOfferCall(meta, "")}`;
  }

  if (featureFlags.googleReady && routedId === "scheduler") {
    const connected = await isCalendarApiReady(env.DEFAULT_SALES_REP_ID);
    lines.push(`- googleCalendarConnected: ${connected}`);
    lines.push(
      `- businessCalendarTimezone: ${env.SALES_TIMEZONE} (sales rep calendar — not the customer's zone)`
    );
  }

  if (meta.customerTimezone) {
    lines.push(
      `- customerTimezone: ${meta.customerTimezone} (${timezoneLabel(meta.customerTimezone)})`
    );
  } else if (routedId === "scheduler") {
    lines.push(
      `- customerTimezone: (unknown — ask which timezone they are in, e.g. US Eastern, US Pacific, UK)`
    );
  }

  if (meta.pendingTopic) {
    lines.push(`- pendingTopic: ${meta.pendingTopic}`);
  }
  if (meta.salesIntent) {
    lines.push(`- salesIntent: true`);
  }

  if (routedId === "scheduler") {
    const duration = meta.meetingDurationMin ?? 30;
    lines.push(`- meetingDurationMin: ${duration}`);
    lines.push(
      `- meetingBookedInDatabase: ${lead.status === "meeting_booked"}`
    );
    lines.push(`- alreadyHaveName: ${!!lead.name}`);
    lines.push(`- alreadyHaveEmail: ${!!lead.email}`);
    lines.push(`- alreadyHaveTimezone: ${!!meta.customerTimezone}`);
    if (lead.email) {
      lines.push(`- useThisEmailExactly: ${lead.email}`);
    }
  }

  return lines.join("\n");
}

type AgentStreamResult = {
  textStream?: ReadableStream<string>;
  fullStream: AsyncIterable<{ type: string; payload?: { text?: string } }>;
  text: Promise<string>;
};

/** Stream only customer-visible text tokens (faster than fullStream). */
async function* iterateAgentTextStream(
  result: AgentStreamResult
): AsyncGenerator<string> {
  const textStream = result.textStream;
  if (!textStream) return;

  const reader = textStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = typeof value === "string" ? value : "";
      if (text && !isInternalStreamText(text)) yield text;
    }
  } finally {
    reader.releaseLock();
  }
}

const streamOptions = (lead: LeadRow, systemHint: string) => ({
  memory: {
    thread: { id: lead.session_id, title: "Sales chat" },
    resource: lead.session_id,
  },
  maxSteps: 14,
  context: [{ role: "system" as const, content: systemHint }],
});

async function prepareLeadForTurn(
  sessionId: string,
  message: string,
  channel?: string
): Promise<{ lead: LeadRow; meta: ReturnType<typeof parseLeadMeta> }> {
  let lead = await getOrCreateLead({ sessionId, channel });
  await ensureSessionThread(sessionId);
  const meta = bumpUserTurn(lead);

  mergeCustomerTimezone(meta, message);
  mergeMeetingDuration(meta, message);
  mergeConversationTopic(meta, message);

  const extracted = extractContactFromMessage(message);
  const merged = mergeContact(lead, extracted);

  if (
    extracted.email &&
    (extracted.name || lead.name) &&
    (meta.salesIntent || meta.meetingOffered)
  ) {
    meta.meetingOffered = true;
  }

  const nextStatus = resolveLeadStatusAfterMessage(
    message,
    lead,
    meta,
    merged
  );

  if (EXPLICIT_CALL_REQUEST_RE.test(message)) {
    meta.meetingOffered = true;
  }

  if (isSchedulingMessage(message, lead, meta)) {
    meta.meetingOffered = true;
  }

  const patch: Parameters<typeof updateLead>[1] = {
    notes: serializeLeadMeta(meta),
  };
  if (merged.name && merged.name !== lead.name) patch.name = merged.name;
  if (merged.email && merged.email !== lead.email) patch.email = merged.email;
  if (nextStatus && nextStatus !== lead.status) patch.status = nextStatus;

  lead = await updateLead(sessionId, patch);
  return { lead, meta };
}

export async function* streamChat(args: {
  sessionId: string;
  message: string;
  channel?: string;
}): AsyncGenerator<string, void, void> {
  ensureReady();

  const { lead, meta } = await prepareLeadForTurn(
    args.sessionId,
    args.message,
    args.channel
  );

  const merged = mergeContact(lead, extractContactFromMessage(args.message));
  const schedulingStage = getSchedulingStage(lead, merged, args.message, meta);

  const { id: routedId, agent } = routeToAgent(args.message, lead, meta);
  const systemHint = await buildSystemHint(
    lead,
    meta,
    schedulingStage,
    routedId
  );

  // Fix mayOfferMeeting with actual user message for knowledge agent.
  const hintLines = systemHint.split("\n");
  const offerIdx = hintLines.findIndex((l) => l.startsWith("- mayOfferMeeting:"));
  if (offerIdx >= 0 && routedId === "knowledge") {
    hintLines[offerIdx] = `- mayOfferMeeting: ${shouldKnowledgeOfferCall(meta, args.message)}`;
  }
  const finalHint = hintLines.join("\n");

  logger.debug(
    { sessionId: args.sessionId, routedId, leadStatus: lead.status, schedulingStage },
    "Routed chat message"
  );

  if (routedId === "scheduler" && lead.status !== "meeting_booked") {
    const autoReply = await tryAutoBookMeeting({
      lead,
      meta,
      message: args.message,
      sessionId: args.sessionId,
    });
    if (autoReply) {
      yield normalizeAssistantText(autoReply);
      return;
    }
  }

  const result = (await agent.stream(
    args.message,
    streamOptions(lead, finalHint)
  )) as AgentStreamResult;

  let yielded = false;

  try {
    for await (const text of iterateAgentTextStream(result)) {
      yielded = true;
      yield text;
    }

    if (!yielded) {
      for await (const chunk of result.fullStream) {
        const text = extractCustomerText(
          chunk as { type: string; payload?: { text?: string } }
        );
        if (text) {
          yielded = true;
          yield text;
        }
      }
    }

    if (!yielded) {
      const finalText = (await result.text)?.trim();
      if (finalText && !isInternalStreamText(finalText)) {
        yield normalizeAssistantText(finalText);
      }
    }
  } catch (err) {
    logger.error({ err, sessionId: args.sessionId, routedId }, "streamChat failed");
    throw err;
  }
}

export async function generateChat(args: {
  sessionId: string;
  message: string;
  channel?: string;
}): Promise<{ reply: string }> {
  ensureReady();
  const { lead, meta } = await prepareLeadForTurn(
    args.sessionId,
    args.message,
    args.channel
  );

  const merged = mergeContact(lead, extractContactFromMessage(args.message));
  const schedulingStage = getSchedulingStage(lead, merged, args.message, meta);
  const { id: routedId, agent } = routeToAgent(args.message, lead, meta);

  let systemHint = await buildSystemHint(lead, meta, schedulingStage, routedId);
  if (routedId === "knowledge") {
    systemHint = systemHint.replace(
      /- mayOfferMeeting: .+/,
      `- mayOfferMeeting: ${shouldKnowledgeOfferCall(meta, args.message)}`
    );
  }

  const result = await agent.generate(
    args.message,
    streamOptions(lead, systemHint)
  );

  const raw = (result.text ?? "").trim();
  const reply = isInternalStreamText(raw)
    ? "I'm having trouble responding right now. Please try again in a moment."
    : normalizeAssistantText(raw);
  return { reply };
}
