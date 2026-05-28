import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { env } from "@/config/env";
import {
  proposeFreeSlots,
  proposeFreeSlotsForWeek,
} from "@/services/google/calendar.service";
import { getLeadBySession } from "@/services/lead/lead.service";
import { parseLeadMeta } from "@/services/chat/lead-meta";
import { logger } from "@/utils/logger";

const inputSchema = z.object({
  daysAhead: z
    .number()
    .int()
    .min(1)
    .max(14)
    .optional()
    .describe("How many days to look ahead (default: 10)."),
  count: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("How many slots to return (default: 3)."),
  durationMin: z
    .number()
    .int()
    .min(15)
    .max(120)
    .optional()
    .describe("Length of the meeting in minutes (default: 30)."),
  weekOf: z
    .string()
    .optional()
    .describe(
      "If set (ISO date), only return slots in that calendar week — use when customer's preferred time was busy."
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      "Chat session id — used to show slot times in the customer's timezone when known."
    ),
  durationMin: z
    .number()
    .int()
    .min(15)
    .max(120)
    .optional()
    .describe("Meeting length in minutes (default from lead or 30)."),
});

const outputSchema = z.object({
  slots: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      humanReadable: z.string(),
    })
  ),
  notConnected: z.boolean().optional(),
  reason: z
    .enum(["not_connected", "no_slots", "error"])
    .optional(),
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

export const proposeSlotsTool = createTool({
  id: "propose-meeting-slots",
  description:
    "List open 30-minute meeting slots. Use weekOf when showing alternatives for a specific week. " +
    "Use without weekOf only when the customer says they are flexible / any time works.",
  inputSchema,
  outputSchema,
  execute: async (inputData) => {
    try {
      let durationMin = inputData.durationMin;
      if (inputData.sessionId && durationMin == null) {
        const lead = await getLeadBySession(inputData.sessionId);
        const meta = parseLeadMeta(lead?.notes ?? null);
        durationMin = meta.meetingDurationMin ?? 30;
      }

      const raw = inputData.weekOf
        ? await proposeFreeSlotsForWeek({
            salesRepId: env.DEFAULT_SALES_REP_ID,
            weekOf: inputData.weekOf,
            count: inputData.count,
            durationMin,
          })
        : await proposeFreeSlots({
            salesRepId: env.DEFAULT_SALES_REP_ID,
            daysAhead: inputData.daysAhead,
            count: inputData.count,
            durationMin,
          });

      const tz = await displayTimezone(inputData.sessionId);
      const slots = raw.map((s) => ({
        start: s.start,
        end: s.end,
        humanReadable: formatSlot(s.start, tz),
      }));

      if (slots.length === 0) {
        return { slots: [], reason: "no_slots" as const };
      }

      return { slots };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "proposeSlotsTool failed");
      if (
        msg.toLowerCase().includes("connected") ||
        msg.toLowerCase().includes("oauth") ||
        msg.toLowerCase().includes("insufficient") ||
        msg.toLowerCase().includes("permission") ||
        msg.toLowerCase().includes("scope")
      ) {
        return { slots: [], notConnected: true, reason: "not_connected" as const };
      }
      return { slots: [], reason: "error" as const };
    }
  },
});
