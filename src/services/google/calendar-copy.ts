import { getCompanyPersona } from "@/mastra/agents/persona";
import { formatInTimezone } from "@/utils/timezone";

export function buildCalendarEventFields(args: {
  attendeeName?: string;
  attendeeEmail: string;
  startTime: string;
  endTime: string;
  /** Customer IANA timezone for human-readable times in the invite. */
  displayTimezone?: string;
}): { summary: string; description: string } {
  const persona = getCompanyPersona();
  const company = persona.name?.trim();
  const guest =
    args.attendeeName?.trim() || args.attendeeEmail.split("@")[0] || "Guest";
  const tz = args.displayTimezone;

  const summary = company
    ? `${company} — Discovery call with ${guest}`
    : `Discovery call with ${guest}`;

  const when =
    tz != null
      ? `${formatInTimezone(args.startTime, tz)} – ${formatInTimezone(args.endTime, tz)} (${tz})`
      : `${formatInTimezone(args.startTime, "UTC")} – ${formatInTimezone(args.endTime, "UTC")} UTC`;

  const intro = company
    ? `${company} discovery call`
    : "Discovery call";

  const description = [
    intro,
    "",
    `Guest: ${guest}`,
    `Email: ${args.attendeeEmail}`,
    `When: ${when}`,
    "",
    "Agenda",
    "• Your goals and current workflow",
    "• How we can support your team",
    "• Questions and next steps",
    "",
    "Please join using the Google Meet link in this calendar invite.",
  ].join("\n");

  return { summary, description };
}
