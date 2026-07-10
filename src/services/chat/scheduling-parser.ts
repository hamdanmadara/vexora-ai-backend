/**
 * Parse natural-language meeting times into ISO start/end in a customer timezone.
 */

const TIME_RE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const TOMORROW_RE = /\btomorrow\b/i;
const DAY_AFTER_TOMORROW_RE = /\bday after tomorrow\b/i;
const TODAY_RE = /\btoday\b/i;
const WEEKDAY_RE =
  /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i;

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** "30 may", "May 30th", "30th of May" */
const DAY_THEN_MONTH_RE =
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const MONTH_THEN_DAY_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const SLASH_DATE_RE = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;

const DEFAULT_MEETING_HOUR = 17;
const DEFAULT_MEETING_MINUTE = 0;

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Explicit 4-digit year anywhere in the message ("14 july 2027"). */
const EXPLICIT_YEAR_RE = /\b(20\d{2})\b/;

/** Day-of-week (0=Sun) for `date` as seen in `timeZone`. */
function zonedWeekday(date: Date, timeZone: string): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
}

export function extractMeetingDurationMin(message: string): number | null {
  const m = message.match(/\b(\d{1,3})\s*[-\s]?\s*(minute|min|mins)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 15 && n <= 120) return n;
  }
  if (/\b45\s*min|\b45[- ]minute/i.test(message)) return 45;
  if (/\b60\s*min|\b1\s*hour/i.test(message)) return 60;
  return null;
}

export function hasSchedulingDateHint(message: string): boolean {
  return (
    TOMORROW_RE.test(message) ||
    DAY_AFTER_TOMORROW_RE.test(message) ||
    TODAY_RE.test(message) ||
    WEEKDAY_RE.test(message) ||
    DAY_THEN_MONTH_RE.test(message) ||
    MONTH_THEN_DAY_RE.test(message) ||
    SLASH_DATE_RE.test(message) ||
    /\b\d{1,2}\/\d{1,2}\b/.test(message)
  );
}

function getZonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) =>
    parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** UTC instant for a local wall-clock time in `timeZone`. */
export function localInZoneToUtc(
  local: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timeZone: string
): Date {
  let ts = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );

  for (let i = 0; i < 12; i++) {
    const p = getZonedParts(new Date(ts), timeZone);
    if (
      p.year === local.year &&
      p.month === local.month &&
      p.day === local.day &&
      p.hour === local.hour &&
      p.minute === local.minute
    ) {
      return new Date(ts);
    }
    const minuteDiff =
      (local.year - p.year) * 525_600 +
      (local.month - p.month) * 43_200 +
      (local.day - p.day) * 1_440 +
      (local.hour - p.hour) * 60 +
      (local.minute - p.minute);
    ts += minuteDiff * 60_000;
  }

  return new Date(ts);
}

function monthIndex(name: string): number | null {
  return MONTH_NAMES[name.toLowerCase()] ?? null;
}

/** Pick year so the calendar day is not before today in the customer's zone. */
function resolveYearForDate(
  month: number,
  day: number,
  now: Date,
  timeZone: string
): number {
  const today = getZonedParts(now, timeZone);
  let year = today.year;
  const probe = localInZoneToUtc(
    { year, month, day, hour: 23, minute: 59 },
    timeZone
  );
  const endOfToday = localInZoneToUtc(
    {
      year: today.year,
      month: today.month,
      day: today.day,
      hour: 23,
      minute: 59,
    },
    timeZone
  );
  if (probe <= endOfToday) year += 1;
  return year;
}

/**
 * Parse explicit calendar dates: "30 may", "May 30", "30/05", "05/30/2026".
 */
export function parseExplicitCalendarDate(
  message: string,
  now: Date,
  timeZone: string
): { year: number; month: number; day: number } | null {
  // Honor an explicit 4-digit year ("14 july 2027") instead of guessing.
  const yearMatch = message.match(EXPLICIT_YEAR_RE);
  const explicitYear = yearMatch ? parseInt(yearMatch[1]!, 10) : null;

  const dm = message.match(DAY_THEN_MONTH_RE);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const month = monthIndex(dm[2]);
    if (month && day >= 1 && day <= 31) {
      return {
        year: explicitYear ?? resolveYearForDate(month, day, now, timeZone),
        month,
        day,
      };
    }
  }

  const md = message.match(MONTH_THEN_DAY_RE);
  if (md) {
    const month = monthIndex(md[1]);
    const day = parseInt(md[2], 10);
    if (month && day >= 1 && day <= 31) {
      return {
        year: explicitYear ?? resolveYearForDate(month, day, now, timeZone),
        month,
        day,
      };
    }
  }

  const slash = message.match(SLASH_DATE_RE);
  if (slash) {
    const a = parseInt(slash[1], 10);
    const b = parseInt(slash[2], 10);
    let day: number;
    let month: number;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    let year = resolveYearForDate(month, day, now, timeZone);
    if (slash[3]) {
      const y = parseInt(slash[3], 10);
      year = y < 100 ? 2000 + y : y;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }

  return null;
}

export function extractTimeFromMessage(
  message: string,
  fallback?: { hour: number; minute: number }
): { hour: number; minute: number } | null {
  const timeMatch = message.match(TIME_RE);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3].toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }
  if (fallback) return fallback;
  if (hasSchedulingDateHint(message)) {
    return { hour: DEFAULT_MEETING_HOUR, minute: DEFAULT_MEETING_MINUTE };
  }
  return null;
}

function resolveBaseDate(
  message: string,
  now: Date,
  timeZone: string
): { year: number; month: number; day: number } | null {
  const explicit = parseExplicitCalendarDate(message, now, timeZone);
  if (explicit) return explicit;

  let base = getZonedParts(now, timeZone);
  const dayOffset = DAY_AFTER_TOMORROW_RE.test(message)
    ? 2
    : TOMORROW_RE.test(message)
      ? 1
      : 0;

  if (dayOffset > 0) {
    const noon = localInZoneToUtc(
      {
        year: base.year,
        month: base.month,
        day: base.day,
        hour: 12,
        minute: 0,
      },
      timeZone
    );
    base = getZonedParts(
      new Date(noon.getTime() + dayOffset * 86_400_000),
      timeZone
    );
    return { year: base.year, month: base.month, day: base.day };
  }

  if (TODAY_RE.test(message)) {
    return { year: base.year, month: base.month, day: base.day };
  }

  // "monday" / "next friday" → the NEXT occurrence of that weekday in the
  // customer's timezone (same-day allowed only without the "next" prefix;
  // a same-day time already in the past rolls forward a week in
  // parsePreferredMeetingTime).
  const wd = message.match(WEEKDAY_RE);
  if (wd) {
    const target = WEEKDAY_INDEX[wd[2]!.slice(0, 3).toLowerCase()];
    if (target != null) {
      const noon = localInZoneToUtc(
        {
          year: base.year,
          month: base.month,
          day: base.day,
          hour: 12,
          minute: 0,
        },
        timeZone
      );
      const todayDow = zonedWeekday(noon, timeZone);
      let offset = (target - todayDow + 7) % 7;
      if (offset === 0 && wd[1]) offset = 7; // "next monday" on a Monday
      const targetDate = getZonedParts(
        new Date(noon.getTime() + offset * 86_400_000),
        timeZone
      );
      return {
        year: targetDate.year,
        month: targetDate.month,
        day: targetDate.day,
      };
    }
  }

  return null;
}

export function parsePreferredMeetingTime(args: {
  message: string;
  timeZone: string;
  durationMin: number;
  now?: Date;
  /** Last time customer mentioned (e.g. 5 PM earlier in the thread). */
  preferredTime?: { hour: number; minute: number };
}): { startTime: string; endTime: string } | null {
  const { message, timeZone, durationMin, preferredTime } = args;
  const now = args.now ?? new Date();

  const time = extractTimeFromMessage(message, preferredTime);
  if (!time) return null;

  const baseDate = resolveBaseDate(message, now, timeZone);
  if (!baseDate) return null;

  let start = localInZoneToUtc(
    {
      year: baseDate.year,
      month: baseDate.month,
      day: baseDate.day,
      hour: time.hour,
      minute: time.minute,
    },
    timeZone
  );

  // "friday 9am" said on a Friday afternoon → they mean NEXT Friday.
  if (
    start.getTime() <= now.getTime() - 60_000 &&
    WEEKDAY_RE.test(message) &&
    !TODAY_RE.test(message) &&
    !parseExplicitCalendarDate(message, now, timeZone)
  ) {
    start = new Date(start.getTime() + 7 * 86_400_000);
  }

  if (start.getTime() <= now.getTime() - 60_000) return null;

  const end = new Date(start.getTime() + durationMin * 60_000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}
