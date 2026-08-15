import { generateObject } from "ai";
import { z } from "zod";
import { getPool } from "@/db/pool";
import { chatModel } from "@/mastra/model";
import { env, featureFlags } from "@/config/env";
import { BadRequestError, FeatureDisabledError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { getAnalyticsOverview } from "./analytics.service";
import { resolvePeriod, type PeriodRange } from "./period";

const TENANT = "default";

/**
 * Caps that keep one report's cost and latency bounded regardless of how
 * busy the month was. Conversations are summarised in batches (map) and the
 * batch summaries synthesised into the final report (reduce), so token use
 * grows with the number of batches, not with raw transcript length.
 */
const MAX_CONVERSATIONS = 400;
const MAX_MESSAGES_PER_CONVERSATION = 24;
const MAX_CHARS_PER_MESSAGE = 600;
const CONVERSATIONS_PER_BATCH = 20;

// ---------------------------------------------------------------------------
// PII scrubbing — transcripts go to a third-party model, so identifiers are
// removed before they ever leave the process. Insights are about patterns,
// never about individuals.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /https?:\/\/\S+/g;

function scrub(text: string, names: string[]): string {
  let out = text.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
  out = out.replace(URL_RE, "[link]");
  for (const name of names) {
    if (name.length < 3) continue;
    out = out.replace(new RegExp(escapeRegExp(name), "gi"), "[name]");
  }
  return out.slice(0, MAX_CHARS_PER_MESSAGE);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const BatchSchema = z.object({
  topics: z
    .array(z.object({ topic: z.string(), mentions: z.number() }))
    .describe("Themes customers asked about, with how many conversations."),
  knowledgeGaps: z
    .array(
      z.object({
        topic: z.string(),
        occurrences: z.number(),
        evidence: z.string().describe("A short paraphrase of what was asked."),
      })
    )
    .describe(
      "Questions the assistant could not answer well from its documents."
    ),
  objections: z.array(
    z.object({ objection: z.string(), occurrences: z.number() })
  ),
  missedOpportunities: z.array(
    z.object({ pattern: z.string(), occurrences: z.number() })
  ),
  competitorMentions: z.array(z.string()),
  sentiment: z.object({
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
  }),
});

const ReportSchema = z.object({
  summary: z
    .string()
    .describe("3-4 sentence executive summary a manager can read."),
  highlights: z
    .array(z.string())
    .describe("3-5 single-sentence key findings."),
  topics: z.array(
    z.object({
      topic: z.string(),
      mentions: z.number(),
      insight: z.string(),
    })
  ),
  knowledgeGaps: z.array(
    z.object({
      topic: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      occurrences: z.number(),
      recommendation: z
        .string()
        .describe("Concretely, what document or content to add."),
    })
  ),
  objections: z.array(
    z.object({
      objection: z.string(),
      occurrences: z.number(),
      suggestedResponse: z.string(),
    })
  ),
  missedOpportunities: z.array(
    z.object({
      pattern: z.string(),
      occurrences: z.number(),
      recommendation: z.string(),
    })
  ),
  competitorMentions: z.array(
    z.object({ name: z.string(), occurrences: z.number() })
  ),
  recommendedActions: z.array(
    z.object({
      action: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      rationale: z.string(),
    })
  ),
  sentiment: z.object({
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
  }),
});

export type AiReportInsights = z.infer<typeof ReportSchema>;

export interface AnalyticsReportRecord {
  period: string;
  status: "generating" | "ready" | "failed";
  model: string | null;
  insights: AiReportInsights | Record<string, never>;
  metricsSnapshot: Record<string, unknown>;
  conversationCount: number;
  messageCount: number;
  error: string | null;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Transcript loading
// ---------------------------------------------------------------------------

interface LoadedConversation {
  sessionId: string;
  channel: string;
  status: string;
  turns: Array<{ role: string; text: string }>;
}

async function loadConversations(
  range: PeriodRange
): Promise<LoadedConversation[]> {
  const pool = getPool();

  const { rows: leads } = await pool.query<{
    session_id: string;
    channel: string;
    status: string;
    name: string | null;
  }>(
    `select session_id, channel, status, name
       from leads
      where tenant_id = $1 and created_at >= $2 and created_at < $3
      order by created_at asc
      limit ${MAX_CONVERSATIONS}`,
    [TENANT, range.start, range.end]
  );

  if (leads.length === 0) return [];

  const conversations: LoadedConversation[] = [];
  for (const lead of leads) {
    const { rows: messages } = await pool.query<{
      role: string;
      content: unknown;
    }>(
      `select role, content
         from mastra_messages
        where thread_id like $1
        order by "createdAt" asc
        limit ${MAX_MESSAGES_PER_CONVERSATION}`,
      [`${lead.session_id}%`]
    );

    const names = lead.name ? [lead.name] : [];
    const turns = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        text: scrub(extractText(m.content), names),
      }))
      .filter((t) => t.text.length > 0);

    if (turns.length === 0) continue;
    conversations.push({
      sessionId: lead.session_id,
      channel: lead.channel,
      status: lead.status,
      turns,
    });
  }

  return conversations;
}

function extractText(content: unknown): string {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return value as string;
    }
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: string })?.text === "string"
            ? (part as { text: string }).text
            : ""
      )
      .join(" ")
      .trim();
  }
  if (value && typeof value === "object") {
    const obj = value as { text?: unknown; content?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (obj.content !== undefined) return extractText(obj.content);
  }
  return "";
}

function renderConversation(c: LoadedConversation, index: number): string {
  const lines = c.turns.map(
    (t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.text}`
  );
  return [
    `--- Conversation ${index + 1} (channel: ${c.channel}, outcome: ${c.status}) ---`,
    ...lines,
  ].join("\n");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generation (map → reduce)
// ---------------------------------------------------------------------------

const ANALYST_ROLE = `You are a sales-conversation analyst for a company that uses an AI sales assistant on its website and support channels. The assistant answers questions from the company's uploaded documents and books sales meetings.

Transcripts have been anonymised: [name], [email], [phone] and [link] are redaction markers, never real content. Never speculate about individuals — report patterns only.`;

async function summariseBatch(
  batch: LoadedConversation[],
  batchIndex: number
): Promise<z.infer<typeof BatchSchema>> {
  const transcript = batch
    .map((c, i) => renderConversation(c, i))
    .join("\n\n");

  const { object } = await generateObject({
    model: chatModel(),
    schema: BatchSchema,
    system: ANALYST_ROLE,
    prompt: `Analyse this batch of ${batch.length} customer conversations and extract structured observations.

Focus especially on KNOWLEDGE GAPS: questions where the assistant hedged, apologised, said it lacked information, gave a vague answer, or where the customer had to repeat themselves. Those indicate documents the company should upload.

Counts must reflect how many conversations in THIS batch showed the pattern.

${transcript}`,
  });

  logger.debug({ batchIndex, size: batch.length }, "analytics: batch summarised");
  return object;
}

async function synthesise(
  batches: Array<z.infer<typeof BatchSchema>>,
  period: string,
  conversationCount: number,
  metrics: Awaited<ReturnType<typeof getAnalyticsOverview>>
): Promise<AiReportInsights> {
  const { object } = await generateObject({
    model: chatModel(),
    schema: ReportSchema,
    system: ANALYST_ROLE,
    prompt: `Synthesise one monthly report for ${period} from the batch observations below.

Context for the same period (already computed, use it to ground your summary):
- Conversations started: ${metrics.kpis.conversations.value} (${conversationCount} of them had a transcript and were analysed here; the rest opened the chat without sending a message)
- Meetings booked: ${metrics.kpis.meetings.value}
- Conversion rate: ${metrics.kpis.conversionRate.value}%
- Calls offered: ${metrics.callOutcomes.offered}, contact shared: ${metrics.callOutcomes.accepted}, declined: ${metrics.callOutcomes.declined}
- Documents in the knowledge base: ${metrics.knowledgeBase.ready} ready

Rules:
- Merge duplicate topics/gaps/objections across batches and SUM their counts.
- Order every list by occurrences, highest first. Keep at most 8 items per list.
- Knowledge-gap recommendations must name the document or content to add, e.g. "Add a refund-policy page covering timelines and eligibility".
- recommendedActions: at most 5, each concrete and doable next month.
- Do not invent numbers that contradict the context above.

Batch observations:
${JSON.stringify(batches)}`,
  });

  return object;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface ReportRow {
  period: string;
  status: "generating" | "ready" | "failed";
  model: string | null;
  insights: AiReportInsights | Record<string, never>;
  metrics_snapshot: Record<string, unknown>;
  conversation_count: number;
  message_count: number;
  error: string | null;
  generated_at: Date;
}

function toRecord(row: ReportRow): AnalyticsReportRecord {
  return {
    period: row.period,
    status: row.status,
    model: row.model,
    insights: row.insights,
    metricsSnapshot: row.metrics_snapshot,
    conversationCount: row.conversation_count,
    messageCount: row.message_count,
    error: row.error,
    generatedAt: new Date(row.generated_at).toISOString(),
  };
}

export async function getSavedReport(
  period: string
): Promise<AnalyticsReportRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<ReportRow>(
    `select period, status, model, insights, metrics_snapshot,
            conversation_count, message_count, error, generated_at
       from analytics_reports
      where tenant_id = $1 and period = $2`,
    [TENANT, period]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listSavedReportPeriods(): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ period: string }>(
    `select period from analytics_reports
      where tenant_id = $1 and status = 'ready'
      order by period desc`,
    [TENANT]
  );
  return rows.map((r) => r.period);
}

async function markGenerating(period: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `insert into analytics_reports (tenant_id, period, status, generated_at)
          values ($1, $2, 'generating', now())
     on conflict (tenant_id, period) do update
        set status = 'generating', error = null, generated_at = now()`,
    [TENANT, period]
  );
}

async function saveReport(
  period: string,
  insights: AiReportInsights,
  metrics: unknown,
  conversationCount: number,
  messageCount: number
): Promise<AnalyticsReportRecord> {
  const pool = getPool();
  const { rows } = await pool.query<ReportRow>(
    `insert into analytics_reports
       (tenant_id, period, status, model, insights, metrics_snapshot,
        conversation_count, message_count, error, generated_at)
     values ($1, $2, 'ready', $3, $4, $5, $6, $7, null, now())
     on conflict (tenant_id, period) do update
        set status = 'ready', model = excluded.model,
            insights = excluded.insights,
            metrics_snapshot = excluded.metrics_snapshot,
            conversation_count = excluded.conversation_count,
            message_count = excluded.message_count,
            error = null, generated_at = now()
     returning period, status, model, insights, metrics_snapshot,
               conversation_count, message_count, error, generated_at`,
    [
      TENANT,
      period,
      env.OPENAI_CHAT_MODEL,
      JSON.stringify(insights),
      JSON.stringify(metrics),
      conversationCount,
      messageCount,
    ]
  );
  return toRecord(rows[0]!);
}

async function markFailed(period: string, message: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `update analytics_reports
        set status = 'failed', error = $3
      where tenant_id = $1 and period = $2`,
    [TENANT, period, message.slice(0, 500)]
  );
}

/**
 * Generate (or regenerate) the AI report for one month and persist it.
 * Deterministic metrics for the same month are snapshotted alongside, so the
 * saved report stays self-consistent as new conversations arrive.
 */
export async function generateAiReport(
  period: string
): Promise<AnalyticsReportRecord> {
  if (!featureFlags.openaiReady) throw new FeatureDisabledError("OpenAI");
  if (!featureFlags.supabaseReady) throw new FeatureDisabledError("Supabase");

  const range = resolvePeriod(period);
  const conversations = await loadConversations(range);

  if (conversations.length === 0) {
    throw new BadRequestError(
      `No conversations found for ${period}. Pick a month with chat activity.`
    );
  }

  await markGenerating(period);

  try {
    const metrics = await getAnalyticsOverview(period);
    const batches = chunk(conversations, CONVERSATIONS_PER_BATCH);

    logger.info(
      { period, conversations: conversations.length, batches: batches.length },
      "analytics: generating AI report"
    );

    // Map: batches run concurrently — each is an independent summary.
    const summaries = await Promise.all(
      batches.map((batch, i) => summariseBatch(batch, i))
    );

    // Reduce: one synthesis pass over the batch summaries.
    const insights = await synthesise(
      summaries,
      period,
      conversations.length,
      metrics
    );

    const messageCount = conversations.reduce(
      (sum, c) => sum + c.turns.length,
      0
    );

    const saved = await saveReport(
      period,
      insights,
      metrics,
      conversations.length,
      messageCount
    );
    logger.info({ period }, "analytics: AI report saved");
    return saved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, period }, "analytics: AI report generation failed");
    await markFailed(period, message).catch(() => undefined);
    throw err;
  }
}
