import { getPool } from "@/db/pool";
import { getMemory } from "@/mastra/memory";
import { extractMessageText } from "@/utils/message-content";
import { logger } from "@/utils/logger";

export interface HistoryMessage {
  role: string;
  content: string;
  createdAt: string | null;
}

/**
 * Load all chat messages for a browser session.
 *
 * Mastra may store each agent turn under thread_id = `{sessionId}-{uuid}` rather
 * than the bare sessionId, so we query by prefix and merge chronologically.
 */
export async function loadSessionChatHistory(
  sessionId: string
): Promise<HistoryMessage[]> {
  const fromDb = await loadFromPostgres(sessionId);
  if (fromDb.length > 0) return fromDb;

  try {
    const memory = getMemory();
    const exact = await memory.recall({
      threadId: sessionId,
      resourceId: sessionId,
      perPage: false,
    });
    return mapRecallMessages(exact.messages);
  } catch (err) {
    logger.warn({ err, sessionId }, "memory.recall failed for session");
    return [];
  }
}

async function loadFromPostgres(sessionId: string): Promise<HistoryMessage[]> {
  const pool = getPool();
  const prefix = `${sessionId}%`;

  const { rows } = await pool.query<{
    role: string;
    content: unknown;
    createdAt: Date | string;
  }>(
    `select role, content, "createdAt"
       from mastra_messages
      where thread_id like $1 or thread_id = $2
      order by "createdAt" asc`,
    [prefix, sessionId]
  );

  const out: HistoryMessage[] = [];
  for (const row of rows) {
    const role = row.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = extractMessageText(parseStoredContent(row.content));
    if (!content) continue;
    out.push({
      role,
      content,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt ?? ""),
    });
  }
  return out;
}

function parseStoredContent(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function mapRecallMessages(
  messages: Array<{
    role: string;
    content: unknown;
    createdAt?: Date | string | null;
  }>
): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = extractMessageText(parseStoredContent(m.content));
    if (!content) continue;
    out.push({
      role: m.role,
      content,
      createdAt: m.createdAt
        ? m.createdAt instanceof Date
          ? m.createdAt.toISOString()
          : String(m.createdAt)
        : null,
    });
  }
  return out;
}

/** Remove all Mastra threads/messages tied to this browser session. */
export async function clearSessionChatHistory(sessionId: string): Promise<void> {
  const memory = getMemory();
  try {
    await memory.deleteThread(sessionId);
  } catch {
    // thread may not exist under exact id
  }

  const pool = getPool();
  const prefix = `${sessionId}%`;
  await pool.query(`delete from mastra_messages where thread_id like $1 or thread_id = $2`, [
    prefix,
    sessionId,
  ]);
  await pool.query(`delete from mastra_threads where id like $1 or id = $2`, [
    prefix,
    sessionId,
  ]);
}

/** Ensure a stable Mastra thread exists for this session (one thread per session). */
export async function ensureSessionThread(sessionId: string): Promise<void> {
  try {
    const memory = getMemory();
    const existing = await memory.getThreadById({ threadId: sessionId });
    if (existing) return;
    await memory.saveThread({
      thread: {
        id: sessionId,
        resourceId: sessionId,
        title: "Sales chat",
        metadata: {},
      },
    });
  } catch (err) {
    logger.warn({ err, sessionId }, "ensureSessionThread failed");
  }
}
