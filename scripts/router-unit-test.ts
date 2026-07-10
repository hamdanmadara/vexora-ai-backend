import { routeToAgent } from "../src/services/chat/router";
import {
  shouldKnowledgeOfferCall,
  parseLeadMeta,
} from "../src/services/chat/lead-meta";
import {
  isSchedulingMessage,
  isKnowledgeIntentMessage,
  isContactSubmission,
  extractContactFromMessage,
} from "../src/services/chat/scheduling-intent";
import { normalizeAssistantText } from "../src/utils/normalizeText";
import { parsePreferredMeetingTime } from "../src/services/chat/scheduling-parser";
import type { LeadRow } from "../src/services/lead/lead.service";

function lead(partial: Partial<LeadRow>): LeadRow {
  return {
    id: "1",
    tenant_id: "default",
    session_id: "s1",
    name: null,
    email: null,
    channel: "web",
    status: "new",
    notes: null,
    created_at: "",
    updated_at: "",
    ...partial,
  };
}

let pass = 0;
let fail = 0;

function assert(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("OK", label);
  } else {
    fail++;
    console.log("FAIL", label);
  }
}

const meta0 = parseLeadMeta(null);

assert(
  "publish question -> knowledge",
  routeToAgent("I want to publish my ebook", lead({ status: "new" }), meta0).id ===
    "knowledge"
);

assert(
  "tell next steps during scheduling -> knowledge",
  routeToAgent(
    "Tell next steps",
    lead({ status: "collecting_info", name: "John", email: "a@b.com" }),
    { userTurns: 4, meetingOffered: true, customerTimezone: "America/Los_Angeles" }
  ).id === "knowledge"
);

assert(
  "yes do it after pricing -> knowledge not scheduler",
  routeToAgent(
    "Yes do it",
    lead({ status: "engaged", email: "a@b.com" }),
    { userTurns: 2, meetingOffered: true, pendingTopic: "pricing" }
  ).id === "knowledge"
);

assert(
  "name+email with salesIntent -> scheduler",
  routeToAgent(
    "Rayyan\nhamdanmadara86@gmail.com",
    lead({ status: "new" }),
    { userTurns: 3, salesIntent: true, meetingOffered: true }
  ).id === "scheduler"
);

assert(
  "contact submission detected",
  isContactSubmission(
    "Rayyan\nhamdan@test.com",
    lead({ status: "new" }),
    { userTurns: 2, salesIntent: true, meetingOffered: false }
  )
);

assert(
  "no call offer on turn 1",
  !shouldKnowledgeOfferCall(meta0, "What products do you offer?")
);

assert(
  "explicit schedule -> scheduler",
  routeToAgent("Yes schedule a call with me", lead({ status: "new" }), meta0).id ===
    "scheduler"
);

const metaOffered = { userTurns: 2, meetingOffered: true };
assert(
  "short yes after offer -> scheduler",
  routeToAgent("Yes", lead({ status: "meeting_proposed" }), metaOffered).id ===
    "scheduler"
);

const c = extractContactFromMessage("Rayyan\nhamdanmadaraa@gmail.com");
assert("extract name", c.name === "Rayyan");
assert("extract email", c.email === "hamdanmadaraa@gmail.com");

assert(
  "extract name only line",
  extractContactFromMessage("John Will").name === "John Will"
);

assert(
  "email not broken by normalize",
  normalizeAssistantText("Contact hamdanmadara86@gmail.com today.") ===
    "Contact hamdanmadara86@gmail.com today."
);

assert(
  "numbered slots get newlines",
  normalizeAssistantText("Pacific)2) Wed, May 20").includes("Pacific)\n2)")
);

assert(
  "isKnowledgeIntent tell next steps",
  isKnowledgeIntentMessage("Tell next steps")
);

assert(
  "tomorrow 5am parses",
  parsePreferredMeetingTime({
    message: "tomorrow 5 am",
    timeZone: "America/Los_Angeles",
    durationMin: 45,
    now: new Date("2026-05-20T12:00:00Z"),
  }) != null
);

assert(
  "day after tomorrow 5pm parses",
  parsePreferredMeetingTime({
    message: "5 pm day after tomorrow",
    timeZone: "Asia/Karachi",
    durationMin: 30,
    now: new Date("2026-05-20T12:00:00Z"),
  }) != null
);

const may30 = parsePreferredMeetingTime({
  message: "Please schedule a call on 30 may, 5pm pakistan time",
  timeZone: "Asia/Karachi",
  durationMin: 30,
  now: new Date("2026-05-28T10:00:00Z"),
});
assert("30 may 5pm parses", may30 != null);
assert(
  "30 may is future when today is 28 may",
  may30 != null && new Date(may30.startTime) > new Date("2026-05-28T10:00:00Z")
);

const may29FollowUp = parsePreferredMeetingTime({
  message: "Do it on tomorrow then 29 may",
  timeZone: "Asia/Karachi",
  durationMin: 30,
  now: new Date("2026-05-28T12:00:00Z"),
  preferredTime: { hour: 17, minute: 0 },
});
assert("tomorrow/29 may without 5pm still parses", may29FollowUp != null);
assert(
  "29 may is not in the past on 28 may",
  may29FollowUp != null &&
    new Date(may29FollowUp.startTime) > new Date("2026-05-28T12:00:00Z")
);

assert(
  "contact with email routes scheduler after offer",
  routeToAgent(
    "Muhammad Rayyan\nhamdan@test.com\nPakistan time",
    lead({ status: "new", name: null, email: null }),
    { userTurns: 3, meetingOffered: true }
  ).id === "scheduler"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
