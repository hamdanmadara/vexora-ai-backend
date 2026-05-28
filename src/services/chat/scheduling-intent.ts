import type { LeadRow } from "@/services/lead/lead.service";
import { isEmail, normalizeEmail } from "@/utils/validators";
import {
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
  /\b(\d{1,2}(:\d{2})?\s*(am|pm)|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/i;

const KNOWLEDGE_INTENT_RE =
  /\b(tell (me )?(the )?next steps|next steps|how do i|how to|what (products?|features?|pricing)|walk me through|explain|describe|publish(ing)?|ebook|manuscript|royalt|isbn|cover studio|reader app|subscription plan|pull up|show me (the )?plans?)\b/i;

const PRICING_FOLLOWUP_RE =
  /\b(yes(,|\s)?\s*(please|do it|show me|go ahead)|show (me )?(pricing|plans)|do it)\b/i;

const SCHEDULING_CONTINUATION_RE =
  /\b(tomorrow|today|next (mon|tue|wed|thu|fri|sat|sun)|\d{1,2}(:\d{2})?\s*(am|pm)|pick\s*(slot\s*)?[123]|slot\s*[123]|do it for|available time|my (name|email|time)|schedule|meeting|45\s*min|30\s*min|\bpst\b|\best\b|\bpdt\b)\b/i;

const NAME_ONLY_RE = /^[A-Za-z][A-Za-z\s'.-]{1,59}$/;

export interface ExtractedContact {
  email: string | null;
  name: string | null;
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
  if (NAME_ONLY_RE.test(trimmed)) return true;
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

export function extractContactFromMessage(message: string): ExtractedContact {
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
    } else if (line.length >= 2 && line.length <= 80 && !name) {
      const cleaned = line
        .replace(/\b(my name is|i am|i'm|name is)\b/gi, "")
        .trim();
      if (cleaned && NAME_ONLY_RE.test(cleaned)) {
        name = cleaned;
      }
    }
  }

  if (!email) {
    const emailMatch = message.match(EMAIL_IN_TEXT_RE);
    if (emailMatch) email = normalizeEmail(emailMatch[0]);
  }

  if (!name && email) {
    const beforeEmail = message.split(EMAIL_IN_TEXT_RE)[0] ?? "";
    const nameCandidate = beforeEmail
      .replace(/\b(my name is|i am|i'm|name is|email is|and)\b/gi, "")
      .replace(/[,;]/g, " ")
      .trim();
    if (nameCandidate.length >= 2 && nameCandidate.length <= 80) {
      name = nameCandidate;
    }
  }

  if (!name && !email && lines.length === 1 && NAME_ONLY_RE.test(lines[0])) {
    name = lines[0].trim();
  }

  return { email, name };
}

export function isSchedulingMessage(
  message: string,
  lead: LeadRow,
  meta: LeadMeta
): boolean {
  const trimmed = message.trim();

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
