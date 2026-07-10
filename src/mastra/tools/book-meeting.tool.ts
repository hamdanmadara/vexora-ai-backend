import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { env } from "@/config/env";
import { bookMeeting } from "@/services/google/calendar.service";
import {
  getOrCreateLead,
  updateLead,
} from "@/services/lead/lead.service";
import { parseLeadMeta } from "@/services/chat/lead-meta";
import { buildCalendarEventFields } from "@/services/google/calendar-copy";
import { isEmail, normalizeEmail } from "@/utils/validators";
import { logger } from "@/utils/logger";

const inputSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe("The current chat session id."),
  attendeeEmail: z
    .string()
    .describe("Customer's email address. Must be a valid email."),
  attendeeName: z.string().optional().describe("Customer's name, if known."),
  startTime: z
    .string()
    .describe(
      "ISO 8601 start time of the meeting (must come from propose-meeting-slots)."
    ),
  endTime: z
    .string()
    .describe(
      "ISO 8601 end time of the meeting (must come from propose-meeting-slots)."
    ),

});

const outputSchema = z.object({
  ok: z.boolean(),
  meetLink: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  error: z.string().optional(),
});

export const bookMeetingTool = createTool({
  id: "book-meeting",
  description:
    "Create a Google Calendar event with a Google Meet link and invite the customer. " +
    "Call after check-meeting-time returns available=true, or when the customer picked " +
    "slot 1/2/3 from propose-meeting-slots. Use ISO start/end from the check or slot list.",
  inputSchema,
  outputSchema,
  execute: async (inputData) => {
    if (!isEmail(inputData.attendeeEmail)) {
      return {
        ok: false,
        meetLink: null,
        startTime: null,
        endTime: null,
        error: "Invalid email address.",
      };
    }

    try {
      const lead = await getOrCreateLead({ sessionId: inputData.sessionId });
      const meta = parseLeadMeta(lead.notes);
      const { summary, description } = buildCalendarEventFields({
        attendeeName: inputData.attendeeName,
        attendeeEmail: normalizeEmail(inputData.attendeeEmail),
        startTime: inputData.startTime,
        endTime: inputData.endTime,
        displayTimezone: meta.customerTimezone,
      });

      const result = await bookMeeting({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        attendeeEmail: normalizeEmail(inputData.attendeeEmail),
        attendeeName: inputData.attendeeName,
        startTime: inputData.startTime,
        endTime: inputData.endTime,
        summary,
        description,
        displayTimezone: meta.customerTimezone,
        leadId: lead.id,
      });

      await updateLead(inputData.sessionId, {
        email: normalizeEmail(inputData.attendeeEmail),
        name: inputData.attendeeName,
        status: "meeting_booked",
      });

      return {
        ok: true,
        meetLink: result.meetLink,
        startTime: result.startTime,
        endTime: result.endTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "bookMeetingTool failed");
      return {
        ok: false,
        meetLink: null,
        startTime: null,
        endTime: null,
        error: message,
      };
    }
  },
});
