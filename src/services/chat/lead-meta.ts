import type { LeadRow } from "@/services/lead/lead.service";
import { extractTimezoneFromText } from "@/utils/timezone";
import { extractMeetingDurationMin } from "./scheduling-parser";

export interface LeadMeta {
  /** Number of user messages in this session. */
  userTurns: number;
  /** Knowledge agent offered a call — short "yes" should go to scheduler. */
  meetingOffered: boolean;
  /** Customer's IANA timezone once they tell us (e.g. America/New_York). */
  customerTimezone?: string;
  /** Preferred meeting length in minutes (default 30). */
  meetingDurationMin?: number;
  /** Customer showed buying / demo interest — start scheduling when we have contact. */
  salesIntent?: boolean;
  /** Last topic the user asked about (avoids "yes do it" → wrong agent). */
  pendingTopic?: "pricing" | "meeting" | "products" | null;
}

const DEFAULT_META: LeadMeta = { userTurns: 0, meetingOffered: false };

export function parseLeadMeta(notes: string | null): LeadMeta {
  if (!notes) return { ...DEFAULT_META };
  try {
    const parsed = JSON.parse(notes) as Partial<LeadMeta>;
    return {
      userTurns:
        typeof parsed.userTurns === "number" ? parsed.userTurns : 0,
      meetingOffered: !!parsed.meetingOffered,
      customerTimezone:
        typeof parsed.customerTimezone === "string"
          ? parsed.customerTimezone
          : undefined,
      meetingDurationMin:
        typeof parsed.meetingDurationMin === "number"
          ? parsed.meetingDurationMin
          : undefined,
      salesIntent: !!parsed.salesIntent,
      pendingTopic:
        parsed.pendingTopic === "pricing" ||
        parsed.pendingTopic === "meeting" ||
        parsed.pendingTopic === "products"
          ? parsed.pendingTopic
          : undefined,
    };
  } catch {
    return { ...DEFAULT_META };
  }
}

export function serializeLeadMeta(meta: LeadMeta): string {
  return JSON.stringify(meta);
}

export function bumpUserTurn(lead: LeadRow): LeadMeta {
  const meta = parseLeadMeta(lead.notes);
  meta.userTurns += 1;
  return meta;
}

/** Persist customer IANA timezone when they mention it in chat. */
export function mergeCustomerTimezone(meta: LeadMeta, message: string): LeadMeta {
  const tz = extractTimezoneFromText(message);
  if (tz) meta.customerTimezone = tz;
  return meta;
}

export function mergeMeetingDuration(meta: LeadMeta, message: string): LeadMeta {
  const d = extractMeetingDurationMin(message);
  if (d) meta.meetingDurationMin = d;
  return meta;
}

const INTEREST_RE =
  /\b(interested|i'?m interested|want a demo|like to learn more|tell me more|sounds interesting)\b/i;

const PRICING_TOPIC_RE =
  /\b(pricing|price|plans?|subscription|cost|how much)\b/i;

const PRICING_FOLLOWUP_RE =
  /\b(yes(,|\s)?\s*(please|do it|show me|go ahead)|show (me )?(pricing|plans))\b/i;

export function mergeConversationTopic(meta: LeadMeta, message: string): LeadMeta {
  const trimmed = message.trim();
  if (PRICING_TOPIC_RE.test(trimmed) || PRICING_FOLLOWUP_RE.test(trimmed)) {
    meta.pendingTopic = "pricing";
  }
  if (INTEREST_RE.test(trimmed)) {
    meta.salesIntent = true;
    meta.pendingTopic = "meeting";
  }
  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) {
    meta.salesIntent = true;
    meta.pendingTopic = "meeting";
    meta.meetingOffered = true;
  }
  return meta;
}

export function shouldKnowledgeOfferCall(
  meta: LeadMeta,
  message: string
): boolean {
  const trimmed = message.trim();

  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) return true;

  if (INTEREST_RE.test(trimmed) && meta.userTurns >= 1) return true;

  // Strong commercial intent — ok to offer after first answer.
  if (STRONG_BUYING_RE.test(trimmed)) return true;

  // Deeper conversation (3+ user messages) + soft interest signals.
  if (meta.userTurns >= 2 && SOFT_INTEREST_RE.test(trimmed)) return true;

  return false;
}

/** Customer explicitly wants to talk / schedule. */
export const EXPLICIT_CALL_REQUEST_RE =
  /\b(schedule|book( a)? (a )?call|set up a (quick )?call|arrange a call|speak (with|to)|talk to (someone|your team|sales)|want (a|to) (schedule|book)|need (a|to) (schedule|book)|let'?s (schedule|book)|can we (talk|chat|meet)|google meet|zoom call)\b/i;

const STRONG_BUYING_RE =
  /\b(pricing|price|cost|enterprise|custom plan|contract|annual|volume|partnership|integration for our)\b/i;

const SOFT_INTEREST_RE =
  /\b(interested|sounds good|tell me more about (pricing|plans)|ready to (buy|start|move forward))\b/i;
