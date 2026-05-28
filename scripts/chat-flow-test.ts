/**
 * End-to-end chat flow smoke tests (non-streaming for speed).
 * Run: npx tsx scripts/chat-flow-test.ts
 */
import "dotenv/config";
import { generateChat } from "../src/services/chat/chat.service";
import {
  isCalendarApiReady,
  isGoogleConnected,
} from "../src/services/google/oauth.service";
import { env } from "../src/config/env";
import { proposeFreeSlots } from "../src/services/google/calendar.service";

const session = `test-${Date.now()}`;

async function say(label: string, message: string): Promise<string> {
  console.log(`\n--- ${label} ---`);
  console.log(`USER: ${message}`);
  const { reply } = await generateChat({
    sessionId: session,
    message,
    channel: "test",
  });
  console.log(`BOT: ${reply.slice(0, 500)}${reply.length > 500 ? "…" : ""}`);
  return reply;
}

async function main() {
  const gOAuth = await isGoogleConnected(env.DEFAULT_SALES_REP_ID);
  const gReady = await isCalendarApiReady(env.DEFAULT_SALES_REP_ID);
  console.log("Google OAuth row exists:", gOAuth);
  console.log("Google Calendar API ready:", gReady);

  if (gOAuth && !gReady) {
    console.log("\n*** ACTION REQUIRED ***");
    console.log(
      "Your Google token is missing calendar permissions (Insufficient Permission / insufficient_scope)."
    );
    console.log("Reconnect once (backend must be running):");
    console.log(`  http://localhost:${env.PORT}/api/auth/google/connect`);
    console.log("Then re-run this test.\n");
  }

  if (gReady) {
    try {
      const slots = await proposeFreeSlots({
        salesRepId: env.DEFAULT_SALES_REP_ID,
        count: 3,
      });
      console.log("Sample slots:", slots.length, slots.map((s) => s.start));
    } catch (err) {
      console.error("proposeFreeSlots failed:", (err as Error).message);
    }
  }

  const r1 = await say(
    "1 products",
    "What products do you offer?"
  );
  if (/30.min call|schedule|hop on/i.test(r1)) {
    console.warn("FAIL: offered call too early on first message");
  } else {
    console.log("OK: no pushy call on message 1");
  }

  const r2 = await say(
    "2 publish question",
    "I want to make an ebook and publish my book"
  );
  if (/30.min call|schedule a call/i.test(r2)) {
    console.warn("WARN: offered call on publish how-to (may be ok if soft)");
  }

  await say("3 follow-up", "Tell me more about PageVault Publish royalties");

  const r4 = await say(
    "4 pricing interest",
    "What are your subscription pricing plans?"
  );

  const r5 = await say("5 accept call", "Yes I would like to schedule a call");
  if (!/name|email|time|day/i.test(r5)) {
    console.warn("FAIL: should ask for contact/time after accepting");
  }

  const r6 = await say(
    "6 contact",
    "Rayyan\nhamdanmadaraa@gmail.com"
  );
  if (/want me to schedule/i.test(r6)) {
    console.warn("FAIL: repeated schedule confirmation");
  }
  if (!/time|day|when|prefer/i.test(r6)) {
    console.warn("WARN: should ask preferred time");
  }

  const r7 = await say(
    "7 preferred time",
    "Tomorrow at 2pm works for me"
  );
  if (/meet\.google|calendar invite|booked|scheduled/i.test(r7)) {
    console.log("OK: booking or confirmation language");
  } else if (/slot|option|1\.|2\.|taken|available/i.test(r7)) {
    console.log("OK: alternatives or availability check");
  } else if (!gConnected) {
    console.log("SKIP booking (Google not connected)");
  } else {
    console.warn("CHECK r7 manually:", r7.slice(0, 200));
  }

  console.log("\nDone. sessionId:", session);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
