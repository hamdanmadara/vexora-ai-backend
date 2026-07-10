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
  mergeCallDecline,
  mergeConversationTopic,
  mergeCustomerTimezone,
  mergeMeetingDuration,
  mergePreferredMeetingTime,
  parseLeadMeta,
  serializeLeadMeta,
  shouldKnowledgeOfferCall,
} from "./lead-meta";
import { tryAutoBookMeeting } from "./scheduling-booking";
import { parsePreferredMeetingTime } from "./scheduling-parser";
import { ensureSessionThread } from "./chat-history.service";
import {
  formatKnowledgeContext,
  searchKnowledge,
} from "./rag-context.service";
import { normalizeAssistantText } from "@/utils/normalizeText";
import { timezoneLabel } from "@/utils/timezone";

export type StreamChatEvent =
  | { kind: "status"; phase: string }
  | { kind: "delta"; content: string };

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
  routedId: string,
  mayOfferMeeting: boolean
): Promise<string> {
  const now = new Date();
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: meta.customerTimezone ?? env.SALES_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  const lines = [
    `Runtime context:`,
    `- currentDateTime: ${dateLabel} (${meta.customerTimezone ?? env.SALES_TIMEZONE}) — use this for ALL date math (what "tomorrow", "Monday", "next week" mean).`,
    `- sessionId: ${lead.session_id}`,
    `- lead.name: ${lead.name ?? "(unknown)"}`,
    `- lead.email: ${lead.email ?? "(unknown)"}`,
    `- lead.status: ${lead.status}`,
    `- customerTurnCount: ${meta.userTurns}`,
    `- mayOfferMeeting: ${routedId === "knowledge" && mayOfferMeeting}`,
    `- schedulingStage: ${schedulingStage}`,
    `Pass sessionId to any tool that accepts it.`,
  ];

  if (meta.callDeclined) {
    lines.push(
      `- customerDeclinedCall: true (they said no to a call earlier — do NOT suggest a call/demo/meeting again unless they bring it up)`
    );
  }

  if (routedId === "knowledge" && mayOfferMeeting) {
    lines.push(
      `- IMPORTANT: after fully answering, END your reply with ONE short, natural, low-pressure line asking if they'd like a quick call with our team (vary the wording; do NOT ask for their timezone, email, name, or a day/time yet).`
    );
  }

  if (routedId === "scheduler") {
    const connected =
      featureFlags.googleReady &&
      (await isCalendarApiReady(env.DEFAULT_SALES_REP_ID));
    lines.push(`- googleCalendarConnected: ${connected}`);
    if (!connected) {
      lines.push(
        `- schedulingBlocked: true (reconnect Google Calendar in the chat UI before booking)`
      );
    }
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

function maxStepsForAgent(agentId: string): number {
  switch (agentId) {
    case "knowledge":
      return 3;
    case "greeter":
      return 2;
    case "scheduler":
      return 8;
    default:
      return 4;
  }
}

/** Stream customer-visible tokens from fullStream (includes text during generation). */
async function* streamAgentOutput(
  result: AgentStreamResult
): AsyncGenerator<string> {
  for await (const chunk of result.fullStream) {
    const text = extractCustomerText(
      chunk as { type: string; payload?: { text?: string } }
    );
    if (text) yield text;
  }
}

/** Did the reply already invite them to a call? (avoid double-asking) */
const CALL_INVITE_MENTION_RE =
  /\b(call|meeting|meet|demo|chat with|talk (to|with)|hop on|walk you through)\b/i;

/**
 * Deterministic fallback: when we decided to offer a call this turn but the
 * model's answer didn't include the invite, append one natural line so the
 * flow never silently skips the ask.
 */
function fallbackCallInvite(meta: ReturnType<typeof parseLeadMeta>): string {
  const invites = [
    "By the way — if it'd help, we could set up a quick call with our team to walk through this together. Would you be interested?",
    "Also, happy to arrange a short call with our team if you'd like to dive deeper — interested?",
    "If you'd like, we can hop on a quick call with our team to go over the details — would that be helpful?",
  ];
  return invites[meta.userTurns % invites.length]!;
}

const streamOptions = (
  lead: LeadRow,
  systemHint: string,
  agentId: string
) => ({
  memory: {
    thread: { id: lead.session_id, title: "Sales chat" },
    resource: lead.session_id,
  },
  maxSteps: maxStepsForAgent(agentId),
  context: [{ role: "system" as const, content: systemHint }],
});

/** Bare text may be treated as a name only while we're collecting details. */
function expectNameFor(
  lead: LeadRow,
  meta: ReturnType<typeof parseLeadMeta>
): boolean {
  return (
    meta.meetingOffered ||
    !!meta.salesIntent ||
    lead.status === "collecting_info" ||
    lead.status === "meeting_proposed"
  );
}

async function prepareLeadForTurn(
  sessionId: string,
  message: string,
  channel?: string
): Promise<{
  lead: LeadRow;
  meta: ReturnType<typeof parseLeadMeta>;
  offerCall: boolean;
}> {
  let lead = await getOrCreateLead({ sessionId, channel });
  await ensureSessionThread(sessionId);
  const meta = bumpUserTurn(lead);

  mergeCustomerTimezone(meta, message);
  mergeMeetingDuration(meta, message);
  mergePreferredMeetingTime(meta, message);
  mergeConversationTopic(meta, message);
  mergeCallDecline(meta, message);

  const extracted = extractContactFromMessage(message, {
    expectName: expectNameFor(lead, meta),
  });
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

  const isScheduling = isSchedulingMessage(message, lead, meta);
  if (isScheduling) {
    meta.meetingOffered = true;
  }

  // Decide once per turn whether the knowledge agent may invite them to a
  // call; remember that we offered so a plain "yes" next turn goes to the
  // scheduler and we don't re-pester in the meantime. Skip on turns already
  // in the scheduling flow — the invite only makes sense from knowledge.
  const offerCall = !isScheduling && shouldKnowledgeOfferCall(meta, message);
  if (offerCall) {
    meta.meetingOffered = true;
    meta.callOfferTurn = meta.userTurns;
  }

  const patch: Parameters<typeof updateLead>[1] = {
    notes: serializeLeadMeta(meta),
  };
  if (merged.name && merged.name !== lead.name) patch.name = merged.name;
  if (merged.email && merged.email !== lead.email) patch.email = merged.email;
  if (nextStatus && nextStatus !== lead.status) patch.status = nextStatus;

  lead = await updateLead(sessionId, patch);
  return { lead, meta, offerCall };
}

export async function* streamChat(args: {
  sessionId: string;
  message: string;
  channel?: string;
}): AsyncGenerator<StreamChatEvent, void, void> {
  ensureReady();

  const { lead, meta, offerCall } = await prepareLeadForTurn(
    args.sessionId,
    args.message,
    args.channel
  );

  const merged = mergeContact(
    lead,
    extractContactFromMessage(args.message, {
      expectName: expectNameFor(lead, meta),
    })
  );
  const schedulingStage = getSchedulingStage(lead, merged, args.message, meta);

  const { id: routedId, agent } = routeToAgent(args.message, lead, meta);
  let finalHint = await buildSystemHint(
    lead,
    meta,
    schedulingStage,
    routedId,
    offerCall
  );

  if (routedId === "knowledge") {
    yield { kind: "status", phase: "searching" };
    const hits = await searchKnowledge(args.message, 3);
    finalHint = `${finalHint}\n\n${formatKnowledgeContext(hits)}`;
  }

  if (routedId === "scheduler" && meta.customerTimezone) {
    const preferredTime =
      meta.preferredMeetingHour != null
        ? {
            hour: meta.preferredMeetingHour,
            minute: meta.preferredMeetingMinute ?? 0,
          }
        : undefined;
    const parsed = parsePreferredMeetingTime({
      message: args.message,
      timeZone: meta.customerTimezone,
      durationMin: meta.meetingDurationMin ?? 30,
      preferredTime,
    });
    if (parsed) {
      finalHint += [
        "",
        "Parsed customer meeting window (use these ISO values with check-meeting-time):",
        `- parsedStart: ${parsed.startTime}`,
        `- parsedEnd: ${parsed.endTime}`,
        "- Do NOT claim this date is in the past unless check-meeting-time says so.",
      ].join("\n");
    }
  }

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
      yield { kind: "delta", content: normalizeAssistantText(autoReply) };
      return;
    }
  }

  yield { kind: "status", phase: "thinking" };

  const result = (await agent.stream(
    args.message,
    streamOptions(lead, finalHint, routedId)
  )) as AgentStreamResult;

  let yielded = false;
  let replyText = "";

  try {
    for await (const text of streamAgentOutput(result)) {
      yielded = true;
      replyText += text;
      yield { kind: "delta", content: text };
    }

    if (!yielded) {
      const finalText = (await result.text)?.trim();
      if (finalText && !isInternalStreamText(finalText)) {
        replyText = finalText;
        yield {
          kind: "delta",
          content: normalizeAssistantText(finalText),
        };
      }
    }

    if (
      offerCall &&
      routedId === "knowledge" &&
      replyText &&
      !CALL_INVITE_MENTION_RE.test(replyText)
    ) {
      yield {
        kind: "delta",
        content: `\n\n${fallbackCallInvite(meta)}`,
      };
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
  const { lead, meta, offerCall } = await prepareLeadForTurn(
    args.sessionId,
    args.message,
    args.channel
  );

  const merged = mergeContact(
    lead,
    extractContactFromMessage(args.message, {
      expectName: expectNameFor(lead, meta),
    })
  );
  const schedulingStage = getSchedulingStage(lead, merged, args.message, meta);
  const { id: routedId, agent } = routeToAgent(args.message, lead, meta);

  let systemHint = await buildSystemHint(
    lead,
    meta,
    schedulingStage,
    routedId,
    offerCall
  );
  if (routedId === "knowledge") {
    const hits = await searchKnowledge(args.message, 3);
    systemHint = `${systemHint}\n\n${formatKnowledgeContext(hits)}`;
  }

  const result = await agent.generate(
    args.message,
    streamOptions(lead, systemHint, routedId)
  );

  const raw = (result.text ?? "").trim();
  let reply = isInternalStreamText(raw)
    ? "I'm having trouble responding right now. Please try again in a moment."
    : normalizeAssistantText(raw);

  if (
    offerCall &&
    routedId === "knowledge" &&
    !isInternalStreamText(raw) &&
    !CALL_INVITE_MENTION_RE.test(reply)
  ) {
    reply = `${reply}\n\n${fallbackCallInvite(meta)}`;
  }

  return { reply };
}
