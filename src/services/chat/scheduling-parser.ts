/**
 * Parse natural-language meeting times into ISO start/end in a customer timezone.
 */

const TIME_RE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const TOMORROW_RE = /\btomorrow\b/i;
const TODAY_RE = /\btoday\b/i;

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
function localInZoneToUtc(
  local: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timeZone: string
): Date {
  let utc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );

  for (let i = 0; i < 4; i++) {
    const got = getZonedParts(new Date(utc), timeZone);
    const targetMin =
      local.hour * 60 +
      local.minute +
      local.day * 24 * 60 +
      local.month * 31 * 24 * 60;
    const gotMin =
      got.hour * 60 + got.minute + got.day * 24 * 60 + got.month * 31 * 24 * 60;
    const dayDiff = local.day - got.day;
    const minDiff =
      dayDiff * 24 * 60 + (local.hour - got.hour) * 60 + (local.minute - got.minute);
    utc += minDiff * 60_000;
  }

  return new Date(utc);
}

export function parsePreferredMeetingTime(args: {
  message: string;
  timeZone: string;
  durationMin: number;
  now?: Date;
}): { startTime: string; endTime: string } | null {
  const { message, timeZone, durationMin } = args;
  const now = args.now ?? new Date();
  const timeMatch = message.match(TIME_RE);
  if (!timeMatch) return null;

  let hour = parseInt(timeMatch[1], 10);
  const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  const ampm = timeMatch[3].toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  let base = getZonedParts(now, timeZone);
  if (TOMORROW_RE.test(message)) {
    const noon = localInZoneToUtc(
      { year: base.year, month: base.month, day: base.day, hour: 12, minute: 0 },
      timeZone
    );
    base = getZonedParts(new Date(noon.getTime() + 86_400_000), timeZone);
  } else if (TODAY_RE.test(message)) {
    // same day
  } else if (!TOMORROW_RE.test(message) && !TODAY_RE.test(message)) {
    // require a day hint for ambiguous parses
    if (!/\b(mon|tue|wed|thu|fri|sat|sun|next week|\d{1,2}\/)\b/i.test(message)) {
      return null;
    }
  }

  const start = localInZoneToUtc(
    {
      year: base.year,
      month: base.month,
      day: base.day,
      hour,
      minute,
    },
    timeZone
  );

  if (start <= now) return null;

  const end = new Date(start.getTime() + durationMin * 60_000);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}
