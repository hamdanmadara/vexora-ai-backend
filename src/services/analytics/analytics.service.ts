import { getPool } from "@/db/pool";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import {
  daysInPeriod,
  previousPeriod,
  resolvePeriod,
  type PeriodRange,
} from "./period";

const TENANT = "default";

/**
 * `leads.notes` holds the LeadMeta JSON blob (userTurns, pricingAsked,
 * callOfferTurn, ...). It is a text column, so every read guards against a
 * non-JSON value before casting — a bad row must not fail the whole report.
 */
const META_CTE = `
  select
    leads.*,
    case when notes ~ '^\\s*\\{' then notes::jsonb else '{}'::jsonb end as meta
  from leads
  where tenant_id = $1 and created_at >= $2 and created_at < $3
`;

export interface KpiValue {
  value: number;
  previous: number;
  /** Percent change vs previous month; null when the previous month was zero. */
  deltaPct: number | null;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** Share of the top of the funnel (conversations started). */
  pctOfTotal: number;
  /** Share of the immediately preceding stage — where drop-off happens. */
  pctOfPrevious: number;
}

export interface AnalyticsOverview {
  period: string;
  range: { start: string; end: string };
  generatedAt: string;
  kpis: {
    conversations: KpiValue;
    meetings: KpiValue;
    conversionRate: KpiValue;
    avgMessages: KpiValue;
  };
  funnel: FunnelStage[];
  daily: Array<{ date: string; conversations: number; meetings: number }>;
  channels: Array<{ channel: string; conversations: number; booked: number }>;
  hourly: Array<{ hour: number; conversations: number }>;
  timezones: Array<{ timezone: string; conversations: number }>;
  callOutcomes: { offered: number; accepted: number; declined: number };
  engagement: {
    avgTurns: number;
    bounced: number;
    bounceRate: number;
    contactCaptureRate: number;
  };
  knowledgeBase: {
    total: number;
    ready: number;
    processing: number;
    failed: number;
    chunks: number;
    uploadedThisPeriod: number;
  };
  upcomingMeetings: Array<{
    id: string;
    attendeeName: string | null;
    attendeeEmail: string;
    startTime: string;
    meetLink: string | null;
  }>;
  totals: { messages: number; conversationsAllTime: number };
}

interface FunnelRow {
  conversations: number;
  engaged: number;
  interested: number;
  offered: number;
  contact_captured: number;
  booked: number;
  declined: number;
  bounced: number;
  avg_turns: number;
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function delta(value: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((value - previous) / previous) * 1000) / 10;
}

async function loadFunnelRow(range: PeriodRange): Promise<FunnelRow> {
  const pool = getPool();
  // Stages are nested deliberately: reaching a later stage implies every
  // earlier one ("reached this stage or beyond"). Without that, a lead who
  // asks about pricing on their very first message would count as
  // "interested" but not "engaged", and the funnel would widen mid-way —
  // which reads as a broken chart rather than a real drop-off.
  const { rows } = await pool.query<FunnelRow>(
    `with l as (${META_CTE}),
     flags as (
       select
         coalesce((meta->>'userTurns')::int, 0) as turns,
         (meta->>'callDeclined')::boolean is true as declined,
         status = 'meeting_booked' as booked,
         email is not null as has_contact,
         (meta->>'callOfferTurn' is not null
           or (meta->>'meetingOffered')::boolean is true) as was_offered,
         ((meta->>'pricingAsked')::boolean is true
           or (meta->>'salesIntent')::boolean is true) as showed_interest
       from l
     ),
     stages as (
       select
         turns, declined, booked,
         booked or has_contact as contact,
         booked or has_contact or was_offered as offered,
         booked or has_contact or was_offered or showed_interest as interested,
         booked or has_contact or was_offered or showed_interest
           or turns >= 2 as engaged
       from flags
     )
     select
       count(*)::int as conversations,
       count(*) filter (where engaged)::int as engaged,
       count(*) filter (where interested)::int as interested,
       count(*) filter (where offered)::int as offered,
       count(*) filter (where contact)::int as contact_captured,
       count(*) filter (where booked)::int as booked,
       count(*) filter (where declined)::int as declined,
       count(*) filter (where not engaged)::int as bounced,
       coalesce(avg(turns), 0)::float as avg_turns
     from stages`,
    [TENANT, range.start, range.end]
  );
  return (
    rows[0] ?? {
      conversations: 0,
      engaged: 0,
      interested: 0,
      offered: 0,
      contact_captured: 0,
      booked: 0,
      declined: 0,
      bounced: 0,
      avg_turns: 0,
    }
  );
}

async function countMeetings(range: PeriodRange): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count
       from meetings
      where created_at >= $1 and created_at < $2`,
    [range.start, range.end]
  );
  return rows[0]?.count ?? 0;
}

/**
 * Mastra owns `mastra_messages` and creates it lazily, and it keys threads by
 * a `{sessionId}...` prefix rather than the bare id (see chat-history.service).
 * Missing table or an unexpected shape must degrade to zero, never break the
 * dashboard.
 */
async function countMessages(range: PeriodRange): Promise<number> {
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ count: number }>(
      `with l as (${META_CTE})
       select count(*)::int as count
         from mastra_messages m
         join l on m.thread_id like l.session_id || '%'
        where m.role in ('user', 'assistant')`,
      [TENANT, range.start, range.end]
    );
    return rows[0]?.count ?? 0;
  } catch (err) {
    logger.warn({ err }, "analytics: message count unavailable");
    return 0;
  }
}

async function loadDaily(
  range: PeriodRange
): Promise<Array<{ date: string; conversations: number; meetings: number }>> {
  const pool = getPool();
  const tz = env.SALES_TIMEZONE;

  const [leadRows, meetingRows] = await Promise.all([
    pool.query<{ d: string; count: number }>(
      `select to_char(created_at at time zone $4, 'YYYY-MM-DD') as d,
              count(*)::int as count
         from leads
        where tenant_id = $1 and created_at >= $2 and created_at < $3
        group by 1`,
      [TENANT, range.start, range.end, tz]
    ),
    pool.query<{ d: string; count: number }>(
      `select to_char(created_at at time zone $3, 'YYYY-MM-DD') as d,
              count(*)::int as count
         from meetings
        where created_at >= $1 and created_at < $2
        group by 1`,
      [range.start, range.end, tz]
    ),
  ]);

  const leadsByDay = new Map(leadRows.rows.map((r) => [r.d, r.count]));
  const meetingsByDay = new Map(meetingRows.rows.map((r) => [r.d, r.count]));

  // Zero-fill so the line chart has a continuous x-axis for the whole month.
  const days = daysInPeriod(range.period);
  const out: Array<{ date: string; conversations: number; meetings: number }> =
    [];
  for (let day = 1; day <= days; day++) {
    const date = `${range.period}-${String(day).padStart(2, "0")}`;
    out.push({
      date,
      conversations: leadsByDay.get(date) ?? 0,
      meetings: meetingsByDay.get(date) ?? 0,
    });
  }
  return out;
}

async function loadChannels(
  range: PeriodRange
): Promise<Array<{ channel: string; conversations: number; booked: number }>> {
  const pool = getPool();
  const { rows } = await pool.query<{
    channel: string;
    conversations: number;
    booked: number;
  }>(
    `select channel,
            count(*)::int as conversations,
            count(*) filter (where status = 'meeting_booked')::int as booked
       from leads
      where tenant_id = $1 and created_at >= $2 and created_at < $3
      group by channel
      order by conversations desc`,
    [TENANT, range.start, range.end]
  );
  return rows;
}

async function loadHourly(
  range: PeriodRange
): Promise<Array<{ hour: number; conversations: number }>> {
  const pool = getPool();
  const { rows } = await pool.query<{ hour: number; count: number }>(
    `select extract(hour from (created_at at time zone $4))::int as hour,
            count(*)::int as count
       from leads
      where tenant_id = $1 and created_at >= $2 and created_at < $3
      group by 1`,
    [TENANT, range.start, range.end, env.SALES_TIMEZONE]
  );
  const byHour = new Map(rows.map((r) => [r.hour, r.count]));
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    conversations: byHour.get(hour) ?? 0,
  }));
}

async function loadTimezones(
  range: PeriodRange
): Promise<Array<{ timezone: string; conversations: number }>> {
  const pool = getPool();
  const { rows } = await pool.query<{
    timezone: string;
    conversations: number;
  }>(
    `with l as (${META_CTE})
     select meta->>'customerTimezone' as timezone,
            count(*)::int as conversations
       from l
      where meta->>'customerTimezone' is not null
      group by 1
      order by conversations desc
      limit 8`,
    [TENANT, range.start, range.end]
  );
  return rows;
}

async function loadKnowledgeBase(
  range: PeriodRange
): Promise<AnalyticsOverview["knowledgeBase"]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    total: number;
    ready: number;
    processing: number;
    failed: number;
    chunks: number;
    uploaded_this_period: number;
  }>(
    `select count(*)::int as total,
            count(*) filter (where status = 'ready')::int as ready,
            count(*) filter (where status in ('queued','processing'))::int as processing,
            count(*) filter (where status = 'failed')::int as failed,
            coalesce(sum(chunk_count), 0)::int as chunks,
            count(*) filter (
              where uploaded_at >= $2 and uploaded_at < $3
            )::int as uploaded_this_period
       from documents
      where tenant_id = $1`,
    [TENANT, range.start, range.end]
  );
  const r = rows[0];
  return {
    total: r?.total ?? 0,
    ready: r?.ready ?? 0,
    processing: r?.processing ?? 0,
    failed: r?.failed ?? 0,
    chunks: r?.chunks ?? 0,
    uploadedThisPeriod: r?.uploaded_this_period ?? 0,
  };
}

async function loadUpcomingMeetings(): Promise<
  AnalyticsOverview["upcomingMeetings"]
> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    attendee_name: string | null;
    attendee_email: string;
    start_time: Date;
    meet_link: string | null;
  }>(
    `select id, attendee_name, attendee_email, start_time, meet_link
       from meetings
      where start_time >= now() and status = 'scheduled'
      order by start_time asc
      limit 5`
  );
  return rows.map((r) => ({
    id: r.id,
    attendeeName: r.attendee_name,
    attendeeEmail: r.attendee_email,
    startTime: new Date(r.start_time).toISOString(),
    meetLink: r.meet_link,
  }));
}

async function loadAllTimeTotals(): Promise<{
  conversationsAllTime: number;
}> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: number }>(
    `select count(*)::int as count from leads where tenant_id = $1`,
    [TENANT]
  );
  return { conversationsAllTime: rows[0]?.count ?? 0 };
}

function buildFunnel(row: FunnelRow): FunnelStage[] {
  const stages: Array<{ key: string; label: string; count: number }> = [
    { key: "started", label: "Conversations started", count: row.conversations },
    { key: "engaged", label: "Engaged (2+ messages)", count: row.engaged },
    { key: "interested", label: "Showed buying interest", count: row.interested },
    { key: "offered", label: "Offered a call", count: row.offered },
    { key: "contact", label: "Shared contact details", count: row.contact_captured },
    { key: "booked", label: "Meeting booked", count: row.booked },
  ];

  const total = stages[0]?.count ?? 0;
  return stages.map((stage, i) => ({
    ...stage,
    pctOfTotal: pct(stage.count, total),
    pctOfPrevious: i === 0 ? 100 : pct(stage.count, stages[i - 1]!.count),
  }));
}

/**
 * The deterministic half of analytics: everything computable straight from
 * Postgres, for one calendar month, with a period-over-period delta on the
 * headline numbers.
 */
export async function getAnalyticsOverview(
  period: string
): Promise<AnalyticsOverview> {
  const range = resolvePeriod(period);
  const prev = previousPeriod(period);

  const [
    funnelRow,
    prevFunnelRow,
    meetings,
    prevMeetings,
    messages,
    prevMessages,
    daily,
    channels,
    hourly,
    timezones,
    knowledgeBase,
    upcomingMeetings,
    allTime,
  ] = await Promise.all([
    loadFunnelRow(range),
    loadFunnelRow(prev),
    countMeetings(range),
    countMeetings(prev),
    countMessages(range),
    countMessages(prev),
    loadDaily(range),
    loadChannels(range),
    loadHourly(range),
    loadTimezones(range),
    loadKnowledgeBase(range),
    loadUpcomingMeetings(),
    loadAllTimeTotals(),
  ]);

  const conversionRate = pct(funnelRow.booked, funnelRow.conversations);
  const prevConversionRate = pct(
    prevFunnelRow.booked,
    prevFunnelRow.conversations
  );
  const avgMessages =
    funnelRow.conversations > 0
      ? Math.round((messages / funnelRow.conversations) * 10) / 10
      : 0;
  const prevAvgMessages =
    prevFunnelRow.conversations > 0
      ? Math.round((prevMessages / prevFunnelRow.conversations) * 10) / 10
      : 0;

  return {
    period,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    generatedAt: new Date().toISOString(),
    kpis: {
      conversations: {
        value: funnelRow.conversations,
        previous: prevFunnelRow.conversations,
        deltaPct: delta(funnelRow.conversations, prevFunnelRow.conversations),
      },
      meetings: {
        value: meetings,
        previous: prevMeetings,
        deltaPct: delta(meetings, prevMeetings),
      },
      conversionRate: {
        value: conversionRate,
        previous: prevConversionRate,
        deltaPct: delta(conversionRate, prevConversionRate),
      },
      avgMessages: {
        value: avgMessages,
        previous: prevAvgMessages,
        deltaPct: delta(avgMessages, prevAvgMessages),
      },
    },
    funnel: buildFunnel(funnelRow),
    daily,
    channels,
    hourly,
    timezones,
    callOutcomes: {
      offered: funnelRow.offered,
      accepted: funnelRow.contact_captured,
      declined: funnelRow.declined,
    },
    engagement: {
      avgTurns: Math.round(funnelRow.avg_turns * 10) / 10,
      bounced: funnelRow.bounced,
      bounceRate: pct(funnelRow.bounced, funnelRow.conversations),
      contactCaptureRate: pct(
        funnelRow.contact_captured,
        funnelRow.conversations
      ),
    },
    knowledgeBase,
    upcomingMeetings,
    totals: {
      messages,
      conversationsAllTime: allTime.conversationsAllTime,
    },
  };
}

/**
 * Months that actually contain conversations, newest first — so the month
 * picker only ever offers periods with something to show. The current month
 * is always included even when still empty.
 */
export async function listAvailablePeriods(): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ period: string }>(
    `select distinct to_char(created_at at time zone $2, 'YYYY-MM') as period
       from leads
      where tenant_id = $1
      order by period desc
      limit 36`,
    [TENANT, env.SALES_TIMEZONE]
  );
  return rows.map((r) => r.period);
}
