/**
 * Quick check: OAuth row vs actual Calendar API access.
 * Run: npx tsx scripts/verify-google-calendar.ts
 */
import "dotenv/config";
import { env } from "../src/config/env";
import {
  isCalendarApiReady,
  isGoogleConnected,
} from "../src/services/google/oauth.service";

async function main() {
  const oauth = await isGoogleConnected(env.DEFAULT_SALES_REP_ID);
  const api = await isCalendarApiReady(env.DEFAULT_SALES_REP_ID);

  console.log("OAuth credentials in DB:", oauth);
  console.log("Calendar API (freeBusy) works:", api);

  if (oauth && !api) {
    console.log("\nFix: reconnect Google with full calendar scope:");
    console.log(`  http://localhost:${env.PORT}/api/auth/google/connect`);
    console.log(
      "\nWhy: your token was created before free/busy permission was added."
    );
    process.exit(1);
  }

  if (api) {
    console.log("\nCalendar is ready for scheduling.");
  } else if (!oauth) {
    console.log("\nConnect Google first:");
    console.log(`  http://localhost:${env.PORT}/api/auth/google/connect`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
