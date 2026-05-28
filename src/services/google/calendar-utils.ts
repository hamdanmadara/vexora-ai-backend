import { env } from "@/config/env";

export function getSalesTimezone(): string {
  return env.SALES_TIMEZONE;
}

export function getHourInTimezone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(hour, 10);
}

export function isWeekdayInTimezone(date: Date, timeZone: string): boolean {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  return day !== "Sat" && day !== "Sun";
}

/** Start of calendar week (Monday 00:00) for the given instant in tz, as UTC Date. */
export function startOfWeek(date: Date, timeZone: string): Date {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const offsetDays = map[weekday] ?? 0;
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
