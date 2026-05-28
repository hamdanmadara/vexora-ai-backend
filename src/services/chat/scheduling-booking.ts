import { env } from "@/config/env";
import {
  bookMeeting,
  isTimeSlotAvailable,
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

  const slot = parsePreferredMeetingTime({
    message,
    timeZone: meta.customerTimezone,
    durationMin,
  });
  if (!slot) return null;

  try {
    const available = await isTimeSlotAvailable({
      salesRepId: env.DEFAULT_SALES_REP_ID,
      startTime: slot.startTime,
      endTime: slot.endTime,
    });

    if (!available) return null;

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

    const tz = meta.customerTimezone;
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
  } catch {
    return null;
  }
}
