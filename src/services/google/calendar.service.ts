import { google, type calendar_v3 } from "googleapis";
import { randomUUID } from "node:crypto";
import { getAuthorizedClient } from "./oauth.service";
import { getPool } from "@/db/pool";
import { logger } from "@/utils/logger";
import {
  addDays,
  getHourInTimezone,
  getSalesTimezone,
  isWeekdayInTimezone,
  startOfWeek,
} from "./calendar-utils";
import { buildCalendarEventFields } from "./calendar-copy";

export interface FreeSlot {
  start: string; // ISO
  end: string; // ISO
}

const DEFAULT_DURATION_MIN = 30;
const SLOT_GRANULARITY_MIN = 30;
/** Sales rep local hours (inclusive start, end at :00). Start 8 covers ~5 PM Pakistan ≈ 8 AM US Eastern. */
const WORK_HOUR_START = 8;
const WORK_HOUR_END = 18;

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

async function fetchBusyPeriods(
  salesRepId: string,
  timeMin: string,
  timeMax: string
): Promise<calendar_v3.Schema$TimePeriod[]> {
  const auth = await getAuthorizedClient(salesRepId);
  const calendar = google.calendar({ version: "v3", auth });
  const freebusy = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: "primary" }],
    },
  });
  return freebusy.data.calendars?.primary?.busy ?? [];
}

function overlapsBusy(
  start: Date,
  end: Date,
  busy: calendar_v3.Schema$TimePeriod[]
): boolean {
  return busy.some((b) => {
    if (!b.start || !b.end) return false;
    const bs = new Date(b.start);
    const be = new Date(b.end);
    return start < be && end > bs;
  });
}

export type SlotRejectionReason = "past" | "weekend" | "outside_hours";

export function getSlotRejectionReason(
  start: Date,
  end: Date,
  now: Date = new Date()
): SlotRejectionReason | null {
  const tz = getSalesTimezone();
  if (start <= now) return "past";
  if (!isWeekdayInTimezone(start, tz)) return "weekend";
  if (!isWorkingSlot(start, end, now, tz)) return "outside_hours";
  return null;
}

function isWorkingSlot(start: Date, end: Date, now: Date, tz: string): boolean {
  if (start <= now) return false;
  if (!isWeekdayInTimezone(start, tz)) return false;
  const startHour = getHourInTimezone(start, tz);
  const endHour = getHourInTimezone(end, tz);
  const endMinutes = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      minute: "2-digit",
    }).format(end),
    10
  );
  // Allow slots that end at or before 18:00 (e.g. 17:30–18:00).
  const endTotal = endHour * 60 + endMinutes;
  const windowEnd = WORK_HOUR_END * 60;
  return (
    startHour >= WORK_HOUR_START &&
    endTotal <= windowEnd &&
    endTotal > startHour * 60
  );
}

function collectFreeSlots(args: {
  timeMin: Date;
  timeMax: Date;
  busy: calendar_v3.Schema$TimePeriod[];
  count: number;
  durationMin: number;
  tz: string;
}): FreeSlot[] {
  const { timeMin, timeMax, busy, count, durationMin, tz } = args;
  const now = new Date();
  const candidates: FreeSlot[] = [];
  const cursor = new Date(timeMin.getTime());
  cursor.setMinutes(
    Math.ceil(cursor.getMinutes() / SLOT_GRANULARITY_MIN) * SLOT_GRANULARITY_MIN,
    0,
    0
  );

  while (candidates.length < count && cursor < timeMax) {
    const slotEnd = addMinutes(cursor, durationMin);
    if (
      isWorkingSlot(cursor, slotEnd, now, tz) &&
      !overlapsBusy(cursor, slotEnd, busy)
    ) {
      candidates.push({
        start: cursor.toISOString(),
        end: slotEnd.toISOString(),
      });
    }
    cursor.setTime(cursor.getTime() + SLOT_GRANULARITY_MIN * 60_000);
  }

  return candidates;
}

export async function isTimeSlotAvailable(args: {
  salesRepId: string;
  startTime: string;
  endTime: string;
}): Promise<boolean> {
  const start = new Date(args.startTime);
  const end = new Date(args.endTime);

  if (getSlotRejectionReason(start, end)) return false;

  const busy = await fetchBusyPeriods(
    args.salesRepId,
    addMinutes(start, -60).toISOString(),
    addMinutes(end, 60).toISOString()
  );
  return !overlapsBusy(start, end, busy);
}

/**
 * Next available slots over the coming days (default discovery flow).
 */
export async function proposeFreeSlots(args: {
  salesRepId: string;
  daysAhead?: number;
  count?: number;
  durationMin?: number;
}): Promise<FreeSlot[]> {
  const {
    salesRepId,
    daysAhead = 10,
    count = 3,
    durationMin = DEFAULT_DURATION_MIN,
  } = args;

  const now = new Date();
  const timeMin = now;
  const timeMax = addDays(now, daysAhead);

  const busy = await fetchBusyPeriods(
    salesRepId,
    timeMin.toISOString(),
    timeMax.toISOString()
  );

  return collectFreeSlots({
    timeMin,
    timeMax,
    busy,
    count,
    durationMin,
    tz: getSalesTimezone(),
  });
}

/**
 * Free slots within a specific week (when the customer's preferred time is busy).
 */
export async function proposeFreeSlotsForWeek(args: {
  salesRepId: string;
  /** Any ISO instant in the target week. */
  weekOf: string;
  count?: number;
  durationMin?: number;
}): Promise<FreeSlot[]> {
  const {
    salesRepId,
    weekOf,
    count = 3,
    durationMin = DEFAULT_DURATION_MIN,
  } = args;
  const tz = getSalesTimezone();
  const anchor = new Date(weekOf);
  const weekStart = startOfWeek(anchor, tz);
  const weekEnd = addDays(weekStart, 7);

  const busy = await fetchBusyPeriods(
    salesRepId,
    weekStart.toISOString(),
    weekEnd.toISOString()
  );

  return collectFreeSlots({
    timeMin: weekStart,
    timeMax: weekEnd,
    busy,
    count,
    durationMin,
    tz,
  });
}

export interface BookedMeeting {
  eventId: string;
  meetLink: string | null;
  startTime: string;
  endTime: string;
}

export async function bookMeeting(args: {
  salesRepId: string;
  attendeeEmail: string;
  attendeeName?: string;
  startTime: string;
  endTime: string;
  summary?: string;
  description?: string;
  /** Customer timezone for invite copy (optional). */
  displayTimezone?: string;
  leadId?: string | null;
}): Promise<BookedMeeting> {
  const auth = await getAuthorizedClient(args.salesRepId);
  const calendar = google.calendar({ version: "v3", auth });
  const tz = getSalesTimezone();

  const defaults = buildCalendarEventFields({
    attendeeName: args.attendeeName,
    attendeeEmail: args.attendeeEmail,
    startTime: args.startTime,
    endTime: args.endTime,
    displayTimezone: args.displayTimezone,
  });

  const summary = args.summary ?? defaults.summary;
  const description = args.description ?? defaults.description;

  const event = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary,
      description,
      start: { dateTime: args.startTime, timeZone: tz },
      end: { dateTime: args.endTime, timeZone: tz },
      attendees: [
        {
          email: args.attendeeEmail,
          displayName: args.attendeeName,
        },
      ],
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
      reminders: {
        useDefault: true,
      },
    },
  });

  const meetLink =
    event.data.hangoutLink ??
    event.data.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video"
    )?.uri ??
    null;

  try {
    const pool = getPool();
    await pool.query(
      `insert into meetings
         (lead_id, sales_rep_id, provider, event_id, meet_link,
          start_time, end_time, attendee_email, attendee_name, status)
       values ($1, $2, 'google_meet', $3, $4, $5, $6, $7, $8, 'scheduled')`,
      [
        args.leadId ?? null,
        args.salesRepId,
        event.data.id ?? null,
        meetLink,
        args.startTime,
        args.endTime,
        args.attendeeEmail,
        args.attendeeName ?? null,
      ]
    );
  } catch (err) {
    logger.warn({ err }, "Could not persist meeting row");
  }

  return {
    eventId: event.data.id ?? "",
    meetLink,
    startTime: args.startTime,
    endTime: args.endTime,
  };
}
