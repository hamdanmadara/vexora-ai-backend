/**
 * Measure non-streaming chat latency for a pricing question.
 * Run: npx tsx scripts/chat-latency-test.ts
 */
import "dotenv/config";
import { generateChat } from "../src/services/chat/chat.service";
import { env } from "../src/config/env";

const session = `latency-${Date.now()}`;
const message = "Tell me about your pricing plans";

async function main() {
  console.log("Model:", env.OPENAI_CHAT_MODEL);
  const t0 = Date.now();
  const { reply } = await generateChat({
    sessionId: session,
    message,
    channel: "test",
  });
  const ms = Date.now() - t0;
  console.log(`Total: ${ms} ms`);
  console.log(`Reply length: ${reply.length} chars`);
  console.log(`Preview: ${reply.slice(0, 280)}${reply.length > 280 ? "…" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
