import type { LeadRow } from "@/services/lead/lead.service";
import { isEmail, normalizeEmail } from "@/utils/validators";
import { extractTimezoneFromText } from "@/utils/timezone";
import {
  CALL_DECLINE_RE,
  EXPLICIT_CALL_REQUEST_RE,
  type LeadMeta,
} from "./lead-meta";

const EMAIL_IN_TEXT_RE =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/** Short "yes" to book a call — NOT "yes do it" (pricing/product follow-up). */
const MEETING_ACCEPT_ONLY_RE =
  /^(yes|yeah|yep|sure|ok|okay|sounds good|book me|schedule me)[\s!.?]*$/i;

const SLOT_PICK_RE =
  /\b(slot\s*)?([123]|one|two|three|first|second|third)\b/i;

const TIME_HINT_RE =
  /\b(\d{1,2}(:\d{2})?\s*(am|pm)|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|day after tomorrow|today|next week|\d{1,2}\s*(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/i;

const KNOWLEDGE_INTENT_RE =
  /\b(tell (me )?(the )?next steps|next steps|how do i|how to|what (products?|features?|pricing)|walk me through|explain|describe|publish(ing)?|ebook|manuscript|royalt|isbn|cover studio|reader app|subscription plan|pull up|show me (the )?plans?)\b/i;

const PRICING_FOLLOWUP_RE =
  /\b(yes(,|\s)?\s*(please|do it|show me|go ahead)|show (me )?(pricing|plans)|do it)\b/i;

const SCHEDULING_CONTINUATION_RE =
  /\b(tomorrow|day after tomorrow|today|next (mon|tue|wed|thu|fri|sat|sun)|\d{1,2}(:\d{2})?\s*(am|pm)|pick\s*(slot\s*)?[123]|slot\s*[123]|do it for|available time|my (name|email|time)|schedule|meeting|45\s*min|30\s*min|\bpst\b|\best\b|\bpdt\b)\b/i;

const NAME_ONLY_RE = /^[A-Za-z][A-Za-z\s'.-]{1,59}$/;

/** Words that can never appear in a person's name — kills "My timezone is
 * PKT", "Tell me about pricing", "yes please", weekday/month lines, etc. */
const NAME_STOPWORD_RE =
  /\b(timezone|time|zone|pkt|pst|pdt|est|edt|cst|cdt|mst|gmt|utc|ist|bst|cet|am|pm|today|tomorrow|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|email|mail|meeting|call|schedule|book|demo|yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank|please|hello|hi|hey|pricing|price|plan|plans|cost|product|products|subscription|interested|want|need|tell|show|what|how|when|where|which|who|why|can|could|would|about|your|the|this|that|it|is|are|do|does)\b/i;

/** Explicit self-introduction markers — "my name is X", "I'm X", "this is X". */
const NAME_MARKER_RE =
  /\b(?:my name(?:'s| is)|i am|i'?m|this is|name is)\s+([A-Za-z][A-Za-z\s'.-]{1,59})/i;

/**
 * Validate a candidate string as a plausible person name: letters only,
 * at most 4 words, and none of the words a name can't contain.
 */
export function sanitizeNameCandidate(raw: string): string | null {
  const cleaned = raw.replace(/[,;:!?]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 60) return null;
  if (!NAME_ONLY_RE.test(cleaned)) return null;
  if (cleaned.split(/\s+/).length > 4) return null;
  if (NAME_STOPWORD_RE.test(cleaned)) return null;
  return cleaned;
}

export interface ExtractedContact {
  email: string | null;
  name: string | null;
}

export interface ExtractContactOptions {
  /**
   * We are in a scheduling flow and may have just asked for the customer's
   * name — only then may a bare line of text be treated as a name. Explicit
   * "my name is X" works regardless.
   */
  expectName?: boolean;
}

export function isKnowledgeIntentMessage(message: string): boolean {
  const trimmed = message.trim();
  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) return false;
  if (SCHEDULING_CONTINUATION_RE.test(trimmed) && TIME_HINT_RE.test(trimmed)) {
    return false;
  }
  if (SCHEDULING_CONTINUATION_RE.test(trimmed) && /\b(name|email|time|tomorrow|am|pm)\b/i.test(trimmed)) {
    return false;
  }
  if (PRICING_FOLLOWUP_RE.test(trimmed)) return true;
  if (KNOWLEDGE_INTENT_RE.test(trimmed)) return true;
  return false;
}

export function isSchedulingContinuation(message: string): boolean {
  const trimmed = message.trim();
  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) return true;
  if (TIME_HINT_RE.test(trimmed)) return true;
  if (SLOT_PICK_RE.test(trimmed)) return true;
  if (EMAIL_IN_TEXT_RE.test(trimmed)) return true;
  if (MEETING_ACCEPT_ONLY_RE.test(trimmed)) return true;
  if (SCHEDULING_CONTINUATION_RE.test(trimmed)) return true;
  // Answering "which timezone are you in?" with just "Pakistan time" / "PKT".
  if (trimmed.length <= 60 && extractTimezoneFromText(trimmed)) return true;
  if (sanitizeNameCandidate(trimmed)) return true;
  return false;
}

export function isContactSubmission(
  message: string,
  lead: LeadRow,
  meta: LeadMeta
): boolean {
  const contact = extractContactFromMessage(message);
  if (!contact.email) return false;
  const hasName = !!(contact.name || lead.name);
  if (!hasName) return false;
  return !!(
    meta.salesIntent ||
    meta.meetingOffered ||
    lead.status === "collecting_info" ||
    lead.status === "meeting_proposed"
  );
}

export function extractContactFromMessage(
  message: string,
  opts: ExtractContactOptions = {}
): ExtractedContact {
  const lines = message
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let email: string | null = null;
  let name: string | null = null;

  for (const line of lines) {
    const match = line.match(EMAIL_IN_TEXT_RE);
    if (match) {
      email = normalizeEmail(match[0]);
    }
    if (!name) {
      // Explicit "my name is X" always counts, wherever we are in the flow.
      const marker = line.match(NAME_MARKER_RE);
      if (marker) {
        name = sanitizeNameCandidate(marker[1]!);
      } else if (opts.expectName && !match) {
        // A bare line may be a name only when we asked for one, and only
        // if it survives strict validation (≤4 words, no schedule-y words).
        name = sanitizeNameCandidate(line);
      }
    }
  }

  if (!email) {
    const emailMatch = message.match(EMAIL_IN_TEXT_RE);
    if (emailMatch) email = normalizeEmail(emailMatch[0]);
  }

  if (!name && email && opts.expectName) {
    const beforeEmail =
      message.split(EMAIL_IN_TEXT_RE)[0]?.split(/\n/).pop() ?? "";
    const candidate = beforeEmail
      .replace(/\b(my name is|i am|i'm|name is|email is|and|my email)\b/gi, " ")
      .trim();
    name = sanitizeNameCandidate(candidate);
  }

  return { email, name };
}

export function isSchedulingMessage(
  message: string,
  lead: LeadRow,
  meta: LeadMeta
): boolean {
  const trimmed = message.trim();

  // "no thanks / not now" after an offer is a decline, not scheduling —
  // let the knowledge/greeter side respond graciously.
  if (
    CALL_DECLINE_RE.test(trimmed) &&
    !EXPLICIT_CALL_REQUEST_RE.test(trimmed) &&
    !TIME_HINT_RE.test(trimmed) &&
    !EMAIL_IN_TEXT_RE.test(trimmed)
  ) {
    return false;
  }

  if (isKnowledgeIntentMessage(trimmed)) return false;

  if (isContactSubmission(trimmed, lead, meta)) return true;

  if (EXPLICIT_CALL_REQUEST_RE.test(trimmed)) return true;

  if (lead.status === "meeting_booked") {
    return isSchedulingContinuation(trimmed);
  }

  if (
    (lead.status === "meeting_proposed" || lead.status === "collecting_info") &&
    isSchedulingContinuation(trimmed)
  ) {
    return true;
  }

  if (meta.meetingOffered && MEETING_ACCEPT_ONLY_RE.test(trimmed)) {
    return true;
  }

  if (meta.pendingTopic === "meeting" && MEETING_ACCEPT_ONLY_RE.test(trimmed)) {
    return true;
  }

  if (EMAIL_IN_TEXT_RE.test(trimmed) && meta.meetingOffered) return true;

  if (TIME_HINT_RE.test(trimmed) && (meta.meetingOffered || meta.salesIntent || lead.email)) {
    return true;
  }

  if (SLOT_PICK_RE.test(trimmed) && lead.email) return true;

  return false;
}

export function resolveLeadStatusAfterMessage(
  message: string,
  lead: LeadRow,
  meta: LeadMeta,
  contact: { name: string | null; email: string | null }
): LeadRow["status"] | undefined {
  if (lead.status === "meeting_booked") return undefined;

  if (isKnowledgeIntentMessage(message)) return undefined;

  if (EXPLICIT_CALL_REQUEST_RE.test(message)) return "meeting_proposed";

  if (meta.meetingOffered && MEETING_ACCEPT_ONLY_RE.test(message)) {
    return "meeting_proposed";
  }

  if (contact.email && contact.name) {
    if (meta.salesIntent || meta.meetingOffered) {
      return "collecting_info";
    }
  }

  if ((contact.email || contact.name) && (meta.salesIntent || meta.meetingOffered)) {
    if (
      lead.status === "collecting_info" ||
      lead.status === "meeting_proposed"
    ) {
      return "collecting_info";
    }
  }

  if (TIME_HINT_RE.test(message) && (meta.meetingOffered || meta.salesIntent)) {
    return "collecting_info";
  }

  return undefined;
}

export function mergeContact(
  lead: LeadRow,
  extracted: ExtractedContact
): { name: string | null; email: string | null } {
  return {
    name: extracted.name ?? lead.name,
    email:
      extracted.email && isEmail(extracted.email)
        ? extracted.email
        : lead.email,
  };
}

export function getSchedulingStage(
  lead: LeadRow,
  contact: { name: string | null; email: string | null },
  message: string,
  meta: LeadMeta
): string {
  if (lead.status === "meeting_booked") return "booked";
  if (!contact.email || !contact.name) return "collecting_contact";
  if (TIME_HINT_RE.test(message) && meta.customerTimezone) {
    return "checking_preferred_time";
  }
  if (
    !meta.customerTimezone &&
    (lead.status === "collecting_info" ||
      lead.status === "meeting_proposed" ||
      meta.meetingOffered ||
      meta.salesIntent)
  ) {
    return "awaiting_timezone";
  }
  if (TIME_HINT_RE.test(message)) return "checking_preferred_time";
  if (
    (lead.status === "collecting_info" || meta.salesIntent) &&
    contact.email &&
    contact.name
  ) {
    return "awaiting_preferred_time";
  }
  if (lead.status === "meeting_proposed" && contact.email && contact.name) {
    return "awaiting_preferred_time";
  }
  return "collecting_details";
}
