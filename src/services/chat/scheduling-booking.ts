import { env } from "@/config/env";
import {
  bookMeeting,
  getSlotRejectionReason,
  isTimeSlotAvailable,
  proposeFreeSlots,
  proposeFreeSlotsForWeek,
} from "@/services/google/calendar.service";
import type { LeadRow } from "@/services/lead/lead.service";
import { updateLead } from "@/services/lead/lead.service";
import { formatInTimezone, timezoneLabel } from "@/utils/timezone";
import type { LeadMeta } from "./lead-meta";
import {
  extractMeetingDurationMin,
  parsePreferredMeetingTime,
} from "./scheduling-parser";
import { isSchedulingContinuation } from "./scheduling-intent";

function formatAlternativeSlots(
  slots: { start: string; end: string }[],
  tz: string,
  durationMin: number
): string {
  return slots
    .map((s, i) => {
      const start = formatInTimezone(s.start, tz);
      const end = formatInTimezone(s.end, tz);
      return `${i + 1}) ${start} – ${end}`;
    })
    .join("\n");
}

function calendarNotConnectedMessage(): string {
  return (
    "I can't access the sales calendar right now. Please ask your admin to click " +
    '"Reconnect Google Calendar" at the top of the chat, then try scheduling again.'
  );
}

function isCalendarAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("connected") ||
    msg.includes("oauth") ||
    msg.includes("insufficient") ||
    msg.includes("permission") ||
    msg.includes("scope") ||
    msg.includes("credentials")
  );
}

/**
 * When we already have contact + timezone and the user gives a concrete time,
 * book via calendar API directly (avoids LLM re-asks and false confirmations).
 */
export async function tryAutoBookMeeting(args: {
  lead: LeadRow;
  meta: LeadMeta;
  message: string;
  sessionId: string;
}): Promise<string | null> {
  const { lead, meta, message, sessionId } = args;

  if (lead.status === "meeting_booked") return null;
  if (!lead.email || !lead.name || !meta.customerTimezone) return null;
  if (!isSchedulingContinuation(message)) return null;

  const durationMin =
    meta.meetingDurationMin ??
    extractMeetingDurationMin(message) ??
    30;

  const preferredTime =
    meta.preferredMeetingHour != null
      ? {
          hour: meta.preferredMeetingHour,
          minute: meta.preferredMeetingMinute ?? 0,
        }
      : undefined;

  const slot = parsePreferredMeetingTime({
    message,
    timeZone: meta.customerTimezone,
    durationMin,
    preferredTime,
  });
  if (!slot) return null;

  const tz = meta.customerTimezone;
  const start = new Date(slot.startTime);
  const end = new Date(slot.endTime);
  const rejection = getSlotRejectionReason(start, end);

  try {
    if (rejection === "outside_hours") {
      const alternatives = await proposeFreeSlotsForWeek({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        weekOf: slot.startTime,
        count: 3,
        durationMin,
      });
      const requested = formatInTimezone(slot.startTime, tz);
      const lines = [
        `That time (${requested}) is outside our team's meeting hours (8 AM–6 PM ${timezoneLabel(env.SALES_TIMEZONE)}).`,
      ];
      if (alternatives.length > 0) {
        lines.push(
          "",
          "Here are open times the same week — reply with 1, 2, or 3:",
          formatAlternativeSlots(alternatives, tz, durationMin)
        );
      }
      return lines.join("\n");
    }

    if (rejection === "weekend") {
      const requested = formatInTimezone(slot.startTime, tz);
      const alternatives = await proposeFreeSlots({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        daysAhead: 10,
        count: 3,
        durationMin,
      });
      const lines = [
        `${requested} falls on a weekend for our sales calendar.`,
      ];
      if (alternatives.length > 0) {
        lines.push(
          "",
          "Here are the next available weekday times — reply with 1, 2, or 3:",
          formatAlternativeSlots(alternatives, tz, durationMin)
        );
      } else {
        lines.push(
          "",
          "Please pick a weekday (e.g. Friday May 29 at 5 PM Pakistan time)."
        );
      }
      return lines.join("\n");
    }

    if (rejection === "past") {
      return "That time is already in the past. Please share a future day and time.";
    }

    const available = await isTimeSlotAvailable({
      salesRepId: env.DEFAULT_SALES_REP_ID,
      startTime: slot.startTime,
      endTime: slot.endTime,
    });

    if (!available) {
      const alternatives = await proposeFreeSlotsForWeek({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        weekOf: slot.startTime,
        count: 3,
        durationMin,
      });
      const requested = formatInTimezone(slot.startTime, tz);
      const lines = [
        `That slot (${requested}) is already busy on our calendar.`,
      ];
      if (alternatives.length > 0) {
        lines.push(
          "",
          "Here are nearby open times — reply with 1, 2, or 3:",
          formatAlternativeSlots(alternatives, tz, durationMin)
        );
      } else {
        lines.push(
          "",
          "Share another day/time in your timezone and I'll check again."
        );
      }
      return lines.join("\n");
    }

    const booked = await bookMeeting({
      salesRepId: env.DEFAULT_SALES_REP_ID,
      attendeeEmail: lead.email,
      attendeeName: lead.name,
      startTime: slot.startTime,
      endTime: slot.endTime,
      displayTimezone: meta.customerTimezone,
      leadId: lead.id,
    });

    await updateLead(sessionId, { status: "meeting_booked" });

    const startLabel = formatInTimezone(slot.startTime, tz);
    const endLabel = formatInTimezone(slot.endTime, tz);
    const tzShort = timezoneLabel(tz);

    const lines = [
      `You're all set, ${lead.name.split(" ")[0]}! I've booked your ${durationMin}-minute call for ${startLabel} – ${endLabel} (${tzShort}).`,
      "",
    ];

    if (booked.meetLink) {
      lines.push("Video link:", booked.meetLink);
    } else {
      lines.push(
        "You'll receive a calendar invite at " +
          lead.email +
          " with the meeting details."
      );
    }

    return lines.join("\n");
  } catch (err) {
    if (isCalendarAuthError(err)) {
      return calendarNotConnectedMessage();
    }
    return null;
  }
}
