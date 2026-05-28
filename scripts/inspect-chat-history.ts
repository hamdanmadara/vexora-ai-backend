/**
 * Debug script: list recent memory threads and message counts.
 * Usage: npx tsx scripts/inspect-chat-history.ts [sessionId]
 */
import "dotenv/config";
import { getMemory } from "../src/mastra/memory";
import { getPool } from "../src/db/pool";

function textFrom(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const obj = content as {
    content?: unknown;
    parts?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(obj.parts)) {
    return obj.parts
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("");
  }
  if (typeof obj.content === "string") return obj.content;
  return "";
}

async function main() {
  const sessionId = process.argv[2];
  const pool = getPool();

  const tables = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables
      where schemaname = 'public' and tablename like '%mastra%' or tablename like '%message%'
      order by tablename`
  );
  console.log("Tables:", tables.rows.map((r) => r.tablename).join(", "));

  const threadTable = tables.rows.find((r) => r.tablename.includes("thread"));
  const msgTable = tables.rows.find((r) => r.tablename.includes("message"));

  if (threadTable) {
    const threads = await pool.query(
      `select * from ${threadTable.tablename} order by 1 desc limit 5`
    );
    console.log("\nThreads sample:", JSON.stringify(threads.rows, null, 2).slice(0, 800));
  }

  if (msgTable) {
    const counts = await pool.query(
      `select thread_id, count(*)::int as n from ${msgTable.tablename} group by thread_id order by n desc limit 5`
    );
    console.log("\nCounts:", counts.rows);

    const sample = await pool.query(
      `select thread_id, role, content from ${msgTable.tablename}
        where thread_id like 'web-%' order by "createdAt" desc limit 1`
    );
    if (sample.rows[0]) {
      console.log("\nSample message thread:", sample.rows[0].thread_id);
      console.log("content:", JSON.stringify(sample.rows[0].content).slice(0, 500));
    }
  }

  const target = sessionId;
  if (!target) {
    console.log("\nPass sessionId as argv to test recall.");
    process.exit(0);
  }

  const memory = getMemory();
  const result = await memory.recall({
    threadId: target,
    resourceId: target,
    perPage: false,
  });
  console.log("\nRecall", target, "messages:", result.messages.length);
  for (const m of result.messages.slice(0, 4)) {
    const t = textFrom(m.content);
    console.log(` [${m.role}] extracted=${t.length}`, t.slice(0, 60) || "(empty)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
