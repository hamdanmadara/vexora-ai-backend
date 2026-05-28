import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getOrCreateLead,
  getLeadBySession,
  updateLead,
  type LeadStatus,
} from "@/services/lead/lead.service";
import {
  parseLeadMeta,
  serializeLeadMeta,
} from "@/services/chat/lead-meta";
import { isEmail, normalizeEmail } from "@/utils/validators";
import { logger } from "@/utils/logger";

const inputSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "The current chat session id. The agent receives this in its instructions."
    ),
  name: z.string().optional().describe("Customer's name if they shared it."),
  email: z
    .string()
    .optional()
    .describe("Customer's email if they shared it."),
  status: z
    .enum([
      "new",
      "engaged",
      "collecting_info",
      "meeting_proposed",
      "meeting_booked",
      "closed",
    ])
    .optional()
    .describe("Pipeline stage for this lead."),
  customerTimezone: z
    .string()
    .optional()
    .describe(
      "Customer IANA timezone (e.g. America/New_York for US Eastern). " +
        "Set when they tell you their timezone."
    ),
});

const outputSchema = z.object({
  ok: z.boolean(),
  lead: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    status: z.string(),
  }),
});

export const updateLeadTool = createTool({
  id: "update-lead",
  description:
    "Persist what we learn about the customer (name, email, status). " +
    "Call this whenever the customer shares their name or email, " +
    "or when their stage changes (e.g. they agreed to a meeting).",
  inputSchema,
  outputSchema,
  execute: async (inputData) => {
    try {
      // Ensure the lead exists.
      await getOrCreateLead({ sessionId: inputData.sessionId });

      if (inputData.email && !isEmail(inputData.email)) {
        return {
          ok: false,
          lead: { name: null, email: null, status: "new" },
        };
      }

      const existing = await getLeadBySession(inputData.sessionId);
      const meta = parseLeadMeta(existing?.notes ?? null);

      if (inputData.customerTimezone) {
        meta.customerTimezone = inputData.customerTimezone;
      }

      const lead = await updateLead(inputData.sessionId, {
        name: inputData.name,
        email: inputData.email ? normalizeEmail(inputData.email) : undefined,
        status: inputData.status as LeadStatus | undefined,
        notes: serializeLeadMeta(meta),
      });
      return {
        ok: true,
        lead: {
          name: lead.name,
          email: lead.email,
          status: lead.status,
        },
      };
    } catch (err) {
      logger.error({ err }, "updateLeadTool failed");
      return {
        ok: false,
        lead: { name: null, email: null, status: "new" },
      };
    }
  },
});
