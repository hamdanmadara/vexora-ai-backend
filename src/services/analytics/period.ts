/**
 * Calendar-month helpers. Analytics are always scoped to one month so a
 * report has a stable, cacheable identity ("2026-08") and the AI pass never
 * has to chew through the entire history at once.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface PeriodRange {
  /** 'YYYY-MM' */
  period: string;
  /** Inclusive UTC start of the month. */
  start: Date;
  /** Exclusive UTC start of the next month. */
  end: Date;
}

export function isValidPeriod(period: string): boolean {
  return PERIOD_RE.test(period);
}

/** Current month in UTC, as 'YYYY-MM'. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function resolvePeriod(period: string): PeriodRange {
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  return {
    period,
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

/** The month immediately before `period` — used for period-over-period deltas. */
export function previousPeriod(period: string): PeriodRange {
  const { start } = resolvePeriod(period);
  const prevStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)
  );
  return {
    period: `${prevStart.getUTCFullYear()}-${String(prevStart.getUTCMonth() + 1).padStart(2, "0")}`,
    start: prevStart,
    end: start,
  };
}

/** Number of days in the month, for building a zero-filled daily series. */
export function daysInPeriod(period: string): number {
  const { start } = resolvePeriod(period);
  return new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
  ).getUTCDate();
}
