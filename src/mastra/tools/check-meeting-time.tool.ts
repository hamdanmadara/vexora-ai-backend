import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { env } from "@/config/env";
import {
  isTimeSlotAvailable,
  proposeFreeSlotsForWeek,
} from "@/services/google/calendar.service";
import { getLeadBySession } from "@/services/lead/lead.service";
import { parseLeadMeta } from "@/services/chat/lead-meta";
import { logger } from "@/utils/logger";

const inputSchema = z.object({
  startTime: z
    .string()
    .describe(
      "Customer's preferred meeting start in ISO 8601 (e.g. 2026-05-22T14:00:00+05:00)."
    ),
  endTime: z
    .string()
    .describe(
      "Meeting end in ISO 8601 — typically 30 minutes after startTime."
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      "Chat session id — formats alternative slots in the customer's timezone when known."
    ),
});

const outputSchema = z.object({
  available: z.boolean(),
  notConnected: z.boolean().optional(),
  alternativeSlots: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        humanReadable: z.string(),
      })
    )
    .optional(),
  message: z.string().optional(),
});

async function displayTimezone(sessionId?: string): Promise<string> {
  if (sessionId) {
    const lead = await getLeadBySession(sessionId);
    const meta = parseLeadMeta(lead?.notes ?? null);
    if (meta.customerTimezone) return meta.customerTimezone;
  }
  return env.SALES_TIMEZONE;
}

function formatSlot(iso: string, timeZone: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  });
}

export const checkMeetingTimeTool = createTool({
  id: "check-meeting-time",
  description:
    "Check if the customer's preferred date/time is free on the sales calendar. " +
    "If busy, returns alternative open slots for that same week only. " +
    "Call this when the customer gives a specific day/time before booking.",
  inputSchema,
  outputSchema,
  execute: async (inputData) => {
    try {
      const available = await isTimeSlotAvailable({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        startTime: inputData.startTime,
        endTime: inputData.endTime,
      });

      if (available) {
        return {
          available: true,
          message: "That time is available.",
        };
      }

      const alternatives = await proposeFreeSlotsForWeek({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        weekOf: inputData.startTime,
        count: 3,
      });

      const tz = await displayTimezone(inputData.sessionId);

      return {
        available: false,
        message:
          alternatives.length > 0
            ? "That time is already booked. Here are open slots the same week."
            : "That time is not available and no alternate slots were found this week.",
        alternativeSlots: alternatives.map((s) => ({
          start: s.start,
          end: s.end,
          humanReadable: formatSlot(s.start, tz),
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "checkMeetingTimeTool failed");
      if (
        msg.toLowerCase().includes("connected") ||
        msg.toLowerCase().includes("oauth") ||
        msg.toLowerCase().includes("insufficient") ||
        msg.toLowerCase().includes("permission") ||
        msg.toLowerCase().includes("scope")
      ) {
        return {
          available: false,
          notConnected: true,
          message: "Google Calendar is not connected.",
        };
      }
      return {
        available: false,
        message: msg,
      };
    }
  },
});
