import type { LeadRow } from "@/services/lead/lead.service";
import { extractTimezoneFromText } from "@/utils/timezone";
import {
  extractMeetingDurationMin,
  extractTimeFromMessage,
} from "./scheduling-parser";

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
  /** Last time of day the customer asked for (e.g. 5 PM), reused on follow-ups. */
  preferredMeetingHour?: number;
  preferredMeetingMinute?: number;
  /** Customer asked about pricing/cost at some point (buying signal). */
  pricingAsked?: boolean;
  /** Turn number when we last offered a call (avoid re-pestering). */
  callOfferTurn?: number;
  /** Customer declined a call offer — never pitch again unless they ask. */
  callDeclined?: boolean;
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
      preferredMeetingHour:
        typeof parsed.preferredMeetingHour === "number"
          ? parsed.preferredMeetingHour
          : undefined,
      preferredMeetingMinute:
        typeof parsed.preferredMeetingMinute === "number"
          ? parsed.preferredMeetingMinute
          : undefined,
      pricingAsked: !!parsed.pricingAsked,
      callOfferTurn:
        typeof parsed.callOfferTurn === "number"
          ? parsed.callOfferTurn
          : undefined,
      callDeclined: !!parsed.callDeclined,
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

/** Remember 5 PM (etc.) for follow-ups like "tomorrow" without repeating the time. */
export function mergePreferredMeetingTime(
  meta: LeadMeta,
  message: string
): LeadMeta {
  const t = extractTimeFromMessage(message);
  if (t) {
    meta.preferredMeetingHour = t.hour;
    meta.preferredMeetingMinute = t.minute;
  }
  return meta;
}

const INTEREST_RE =
  /\b(interested|i'?m interested|want a demo|like to learn more|tell me more|sounds interesting)\b/i;

const PUBLISH_INTENT_RE =
  /\b(publish(ing)?(\s+my)?\s+book|self[- ]?publish|want to publish)\b/i;

const PRICING_TOPIC_RE =
  /\b(pricing|price|plans?|subscription|cost|how much)\b/i;

const PRICING_FOLLOWUP_RE =
  /\b(yes(,|\s)?\s*(please|do it|show me|go ahead)|show (me )?(pricing|plans))\b/i;

export function mergeConversationTopic(meta: LeadMeta, message: string): LeadMeta {
  const trimmed = message.trim();
  if (PRICING_TOPIC_RE.test(trimmed) || PRICING_FOLLOWUP_RE.test(trimmed)) {
    meta.pendingTopic = "pricing";
    meta.pricingAsked = true;
  }
  if (INTEREST_RE.test(trimmed) || PUBLISH_INTENT_RE.test(trimmed)) {
    meta.salesIntent = true;
    meta.pendingTopic = "meeting";
    meta.callDeclined = false;
  }
  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) {
    meta.salesIntent = true;
    meta.pendingTopic = "meeting";
    meta.meetingOffered = true;
    meta.callDeclined = false;
  }
  return meta;
}

/** "no thanks / not now / just looking" right after we offered a call. */
export const CALL_DECLINE_RE =
  /\b(no thanks?|not (now|yet|really|interested|at the moment)|maybe later|just (looking|browsing|curious)|i'?ll (think|get back)|not right now|some other time)\b/i;

/**
 * If the customer turns down the call offer, remember it and stop pitching.
 * An explicit "book a call" / "I'm interested" later re-opens (handled in
 * mergeConversationTopic which clears callDeclined).
 */
export function mergeCallDecline(meta: LeadMeta, message: string): LeadMeta {
  const trimmed = message.trim();
  if (!CALL_DECLINE_RE.test(trimmed)) return meta;
  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) return meta;
  if (!meta.meetingOffered && meta.pendingTopic !== "meeting") return meta;
  meta.callDeclined = true;
  meta.meetingOffered = false;
  meta.salesIntent = false;
  meta.pendingTopic = null;
  return meta;
}

/**
 * Decide whether the knowledge agent may add its one-line call invite this
 * turn. Philosophy: behave like a good human rep — answer first, read the
 * room, and only suggest a call once the customer is clearly engaged.
 */
export function shouldKnowledgeOfferCall(
  meta: LeadMeta,
  message: string
): boolean {
  const trimmed = message.trim();

  // They said no — never pitch again (explicit interest clears the flag).
  if (meta.callDeclined) return false;

  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) return true;

  // Customer states interest in their own words → offer right away.
  if (INTEREST_RE.test(trimmed) && meta.userTurns >= 1) return true;

  // Otherwise require a real conversation first: at least 3 customer turns
  // AND an accumulated buying signal (they asked about pricing at some point,
  // or this turn carries commercial/soft-interest language).
  const engaged =
    meta.userTurns >= 3 &&
    (meta.pricingAsked ||
      STRONG_BUYING_RE.test(trimmed) ||
      SOFT_INTEREST_RE.test(trimmed));
  if (!engaged) return false;

  // Don't re-pester: if we offered recently and they didn't bite, wait
  // at least 4 more turns before gently suggesting again.
  if (
    meta.callOfferTurn != null &&
    meta.userTurns - meta.callOfferTurn < 4
  ) {
    return false;
  }

  return true;
}

/** Customer explicitly wants to talk / schedule. */
export const EXPLICIT_CALL_REQUEST_RE =
  /\b(schedule|book( a)? (a )?call|set up a (quick )?call|arrange a call|speak (with|to)|talk to (someone|your team|sales)|want (a|to) (schedule|book)|need (a|to) (schedule|book)|let'?s (schedule|book)|can we (talk|chat|meet)|google meet|zoom call)\b/i;

const STRONG_BUYING_RE =
  /\b(pricing|price|cost|enterprise|custom plan|contract|annual|volume|partnership|integration for our)\b/i;

const SOFT_INTEREST_RE =
  /\b(interested|sounds good|tell me more about (pricing|plans)|ready to (buy|start|move forward))\b/i;
