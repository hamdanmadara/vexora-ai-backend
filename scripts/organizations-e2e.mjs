/**
 * Organizations / multi-user E2E against a running backend.
 *
 *   node scripts/organizations-e2e.mjs            # API defaults to :4020
 *   API=http://localhost:4000/api node scripts/...
 *
 * Covers: both signup paths, seat limits, permission boundaries, cross-org
 * isolation (documents, RAG, analytics, sessions), the bot persona, platform
 * admin, suspension, and a regression check that pre-migration accounts still
 * see their data. Creates only *@test.dev accounts; cleans up at the end.
 */
import "dotenv/config";
import pg from "pg";

const B = process.env.API ?? "http://localhost:4020/api";

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${extra}`);
  }
};

async function api(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${B}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

const stamp = Date.now();
const pw = "password123";
const emails = {
  orgA: `org-a-${stamp}@test.dev`,
  orgAMember: `org-a-member-${stamp}@test.dev`,
  orgB: `org-b-${stamp}@test.dev`,
  personal: `solo-${stamp}@test.dev`,
  platform: `platform-${stamp}@test.dev`,
  pwUser: `pw-user-${stamp}@test.dev`,
};

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
console.log("\n== 1. signup: both account types ==");

const orgA = await api("POST", "/auth/signup", {
  body: {
    accountType: "business",
    organizationName: "Alpha Industries",
    name: "Alpha Admin",
    email: emails.orgA,
    password: pw,
    companyDescription: "We make widgets for robots.",
  },
});
check("business signup -> 201", orgA.status === 201, `got ${orgA.status}`);
check(
  "business org created, admin, 1 seat",
  orgA.json?.organization?.type === "business" &&
    orgA.json?.organization?.seatLimit === 1 &&
    orgA.json?.organization?.seatsUsed === 1 &&
    orgA.json?.user?.orgRole === "admin",
  JSON.stringify(orgA.json?.organization)
);
let A = orgA.json.tokens.accessToken;
const orgAId = orgA.json.organization.id;

const solo = await api("POST", "/auth/signup", {
  body: {
    accountType: "personal",
    name: "Solo Person",
    email: emails.personal,
    password: pw,
  },
});
check(
  "personal signup creates a personal org whose owner is its admin",
  solo.status === 201 &&
    solo.json?.organization?.type === "personal" &&
    solo.json?.user?.orgRole === "admin",
  JSON.stringify(solo.json?.organization)
);
const SOLO = solo.json.tokens.accessToken;

const orgB = await api("POST", "/auth/signup", {
  body: {
    accountType: "business",
    organizationName: "Beta Corp",
    name: "Beta Admin",
    email: emails.orgB,
    password: pw,
  },
});
const Bt = orgB.json.tokens.accessToken;
const orgBId = orgB.json.organization.id;
check("second org created", orgB.status === 201 && orgBId !== orgAId);

check(
  "signup cannot mint a platform admin",
  orgA.json?.user?.role === "user" && solo.json?.user?.role === "user"
);

// ---------------------------------------------------------------------------
console.log("\n== 2. seat limits ==");

const overSeat = await api("POST", "/organization/members", {
  token: A,
  body: { name: "Too Many", email: `nope-${stamp}@test.dev`, password: pw },
});
check(
  "adding a 2nd user with seatLimit=1 is refused",
  overSeat.status === 409,
  `got ${overSeat.status} ${overSeat.json?.error?.message ?? ""}`
);

// Promote a platform admin (staff are promoted in SQL, never via signup).
const plat = await api("POST", "/auth/signup", {
  body: {
    accountType: "personal",
    name: "Platform Staff",
    email: emails.platform,
    password: pw,
  },
});
await pool.query(`update users set role = 'platform_admin' where email = $1`, [
  emails.platform,
]);
// Role rides in the token, so it lands on the next refresh.
const platRefreshed = await api("POST", "/auth/refresh", {
  body: { refreshToken: plat.json.tokens.refreshToken },
});
const P = platRefreshed.json.tokens.accessToken;
check(
  "SQL promotion takes effect on refresh",
  platRefreshed.json?.user?.role === "platform_admin",
  JSON.stringify(platRefreshed.json?.user)
);

const raise = await api("PATCH", `/admin/organizations/${orgAId}`, {
  token: P,
  body: { seatLimit: 3 },
});
check("platform admin raises seats to 3", raise.status === 200 && raise.json?.organization?.seatLimit === 3, `got ${raise.status}`);

const addMember = await api("POST", "/organization/members", {
  token: A,
  body: { name: "Alpha Member", email: emails.orgAMember, password: pw },
});
check("admin can now add a user", addMember.status === 201, `got ${addMember.status} ${addMember.json?.error?.message ?? ""}`);

const lower = await api("PATCH", `/admin/organizations/${orgAId}`, {
  token: P,
  body: { seatLimit: 1 },
});
check(
  "seats cannot drop below users already in use",
  lower.status === 400,
  `got ${lower.status}`
);

// ---------------------------------------------------------------------------
console.log("\n== 3. the added member can log in, with member permissions ==");

const memberLogin = await api("POST", "/auth/login", {
  body: { email: emails.orgAMember, password: pw },
});
check(
  "member logs in with the admin-set password and joins the SAME org",
  memberLogin.status === 200 &&
    memberLogin.json?.organization?.id === orgAId &&
    memberLogin.json?.user?.orgRole === "member",
  JSON.stringify(memberLogin.json?.organization)
);
const M = memberLogin.json.tokens.accessToken;

check(
  "member CAN use the workspace (documents)",
  (await api("GET", "/documents", { token: M })).status === 200
);
check(
  "member CANNOT see integration keys",
  (await api("GET", "/integrations", { token: M })).status === 401
);
check(
  "member CANNOT add users",
  (
    await api("POST", "/organization/members", {
      token: M,
      body: { name: "X", email: `x-${stamp}@test.dev`, password: pw },
    })
  ).status === 401
);
check(
  "member CAN see who is on the team",
  (await api("GET", "/organization/members", { token: M })).status === 200
);
check(
  "member CANNOT reach the platform admin area",
  (await api("GET", "/admin/organizations", { token: M })).status === 401
);
check(
  "org admin CAN see integration keys",
  (await api("GET", "/integrations", { token: A })).status === 200
);
check(
  "B2C user CAN see integration keys (admin of their own org)",
  (await api("GET", "/integrations", { token: SOLO })).status === 200
);

// ---------------------------------------------------------------------------
console.log("\n== 4. shared workspace + cross-org isolation ==");

// Org A uploads a document (as the admin).
const form = new FormData();
form.append(
  "files",
  new Blob(["Alpha Industries sells the Widget 3000 for 499 dollars."], {
    type: "text/plain",
  }),
  "alpha-pricing.txt"
);
const upload = await fetch(`${B}/documents`, {
  method: "POST",
  headers: { Authorization: `Bearer ${A}` },
  body: form,
});
check("org admin uploads a document", upload.status === 202, `got ${upload.status}`);

// Wait for ingestion so the RAG check below is meaningful.
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const docs = await api("GET", "/documents", { token: A });
  ready = (docs.json?.documents ?? []).some((d) => d.status === "ready");
}
check("document reached 'ready'", ready);

const memberDocs = await api("GET", "/documents", { token: M });
check(
  "SHARED: the member sees their colleague's document",
  (memberDocs.json?.documents ?? []).length >= 1,
  JSON.stringify(memberDocs.json?.documents?.length)
);

const bDocs = await api("GET", "/documents", { token: Bt });
check(
  "ISOLATED: org B sees none of org A's documents",
  (bDocs.json?.documents ?? []).length === 0,
  JSON.stringify(bDocs.json?.documents?.length)
);

// RAG isolation — org B's bot must not retrieve org A's content.
const bChat = await api("POST", "/chat", {
  token: Bt,
  body: {
    sessionId: `iso-b-${stamp}`,
    message: "How much does the Widget 3000 cost?",
    stream: false,
  },
});
check(
  "ISOLATED: org B's bot does not know org A's pricing",
  bChat.status === 200 && !/499/.test(bChat.json?.reply ?? ""),
  (bChat.json?.reply ?? "").slice(0, 120)
);

// Persona comes from the ORGANIZATION now.
const aChat = await api("POST", "/chat", {
  token: A,
  body: {
    sessionId: `persona-a-${stamp}`,
    message: "What company are you? Reply with the company name only.",
    stream: false,
  },
});
check(
  "PERSONA: org A's bot identifies as Alpha Industries",
  /alpha/i.test(aChat.json?.reply ?? ""),
  (aChat.json?.reply ?? "").slice(0, 120)
);

// Session isolation.
const steal = await api("GET", `/chat/persona-a-${stamp}`, { token: Bt });
check(
  "ISOLATED: org B cannot read org A's session",
  steal.status === 404 || (steal.json?.messages ?? []).length === 0,
  `got ${steal.status}`
);
const stealPost = await api("POST", "/chat", {
  token: Bt,
  body: { sessionId: `persona-a-${stamp}`, message: "hi", stream: false },
});
check(
  "ISOLATED: org B cannot post into org A's session",
  stealPost.status === 404,
  `got ${stealPost.status}`
);

// Analytics isolation.
const month = new Date().toISOString().slice(0, 7);
const aAnalytics = await api("GET", `/analytics/overview?month=${month}`, {
  token: A,
});
const bAnalytics = await api("GET", `/analytics/overview?month=${month}`, {
  token: Bt,
});
check(
  "SHARED: analytics counts the org's own conversations",
  (aAnalytics.json?.kpis?.conversations?.value ?? 0) >= 1
);
check(
  "ISOLATED: org B's analytics excludes org A",
  (bAnalytics.json?.kpis?.conversations?.value ?? 0) <= 1,
  JSON.stringify(bAnalytics.json?.kpis?.conversations)
);

// ---------------------------------------------------------------------------
console.log("\n== 5. platform admin ==");

const list = await api("GET", "/admin/organizations", { token: P });
check(
  "lists every organization",
  list.status === 200 && list.json.organizations.length >= 3,
  `count ${list.json?.organizations?.length}`
);
const detail = await api("GET", `/admin/organizations/${orgAId}`, { token: P });
check(
  "org detail includes members and usage",
  detail.status === 200 &&
    detail.json.organization.members.length === 2 &&
    detail.json.organization.documentCount >= 1,
  JSON.stringify({
    members: detail.json?.organization?.members?.length,
    docs: detail.json?.organization?.documentCount,
  })
);
check(
  "org admin CANNOT reach the admin area",
  (await api("GET", "/admin/organizations", { token: A })).status === 401
);

// ---------------------------------------------------------------------------
console.log("\n== 6. suspension ==");

const suspend = await api("PATCH", `/admin/organizations/${orgBId}`, {
  token: P,
  body: { status: "suspended" },
});
check("suspend org B", suspend.status === 200 && suspend.json.organization.status === "suspended");

const suspendedUse = await api("GET", "/documents", { token: Bt });
check(
  "suspended org is blocked immediately, without waiting for the token to expire",
  suspendedUse.status === 401,
  `got ${suspendedUse.status}`
);
const suspendedLogin = await api("POST", "/auth/login", {
  body: { email: emails.orgB, password: pw },
});
check("suspended org cannot log in", suspendedLogin.status === 401, `got ${suspendedLogin.status}`);

await api("PATCH", `/admin/organizations/${orgBId}`, {
  token: P,
  body: { status: "active" },
});
const reactivated = await api("POST", "/auth/login", {
  body: { email: emails.orgB, password: pw },
});
check("reactivating restores access", reactivated.status === 200, `got ${reactivated.status}`);

// ---------------------------------------------------------------------------
console.log("\n== 7. member lifecycle ==");

const memberId = addMember.json.member.id;
const promote = await api("PATCH", `/organization/members/${memberId}`, {
  token: A,
  body: { orgRole: "admin", name: "Alpha Member Renamed" },
});
check(
  "admin can rename and promote a member",
  promote.status === 200 && promote.json.member.orgRole === "admin",
  `got ${promote.status}`
);

const foreign = await api("PATCH", `/organization/members/${memberId}`, {
  token: Bt,
  body: { name: "Hacked" },
});
check(
  "another org cannot touch this user (404, not 403)",
  foreign.status === 404 || foreign.status === 401,
  `got ${foreign.status}`
);

const selfDelete = await api("DELETE", `/organization/members/${orgA.json.user.id}`, {
  token: A,
});
check("admin cannot delete themselves", selfDelete.status === 401, `got ${selfDelete.status}`);

const del = await api("DELETE", `/organization/members/${memberId}`, { token: A });
check("admin deletes the member (JSON body returned)", del.status === 200 && del.json?.ok === true);

const deadLogin = await api("POST", "/auth/login", {
  body: { email: emails.orgAMember, password: pw },
});
check("deleted user can no longer log in", deadLogin.status === 401, `got ${deadLogin.status}`);

// ---------------------------------------------------------------------------
console.log("\n== 8. pre-migration accounts still work (backfill regression) ==");

const { rows: legacy } = await pool.query(
  `select u.email, o.id as org_id, o.name,
          (select count(*)::int from documents d where d.tenant_id = o.id::text) as docs
     from users u
     join organization_members m on m.user_id = u.id
     join organizations o on o.id = m.organization_id
    where u.email not like '%@test.dev'
      and u.created_at < now() - interval '1 hour'
    order by u.created_at limit 3`
);
check(
  "existing accounts were backfilled into organizations",
  legacy.length > 0,
  `found ${legacy.length}`
);
check(
  "their organization id equals their old tenant id, so their data survived",
  legacy.some((r) => r.docs > 0),
  JSON.stringify(legacy.map((r) => ({ email: r.email, docs: r.docs })))
);

// ---------------------------------------------------------------------------
console.log("\n== 9. anyone can change their own password ==");

const newPw = "password987";

await api("POST", "/organization/members", {
  token: A,
  body: { name: "Password User", email: emails.pwUser, password: pw },
});
const pwLogin = await api("POST", "/auth/login", {
  body: { email: emails.pwUser, password: pw },
});
const PU = pwLogin.json.tokens.accessToken;
const pwUserRefresh = pwLogin.json.tokens.refreshToken;

const wrongCurrent = await api("POST", "/auth/password", {
  token: PU,
  body: { currentPassword: "not-my-password", newPassword: newPw },
});
check(
  "the current password must be correct",
  wrongCurrent.status === 400,
  `got ${wrongCurrent.status}`
);

const shortPw = await api("POST", "/auth/password", {
  token: PU,
  body: { currentPassword: pw, newPassword: "short" },
});
check(
  "a too-short new password is rejected",
  shortPw.status === 400,
  `got ${shortPw.status}`
);

const changed = await api("POST", "/auth/password", {
  token: PU,
  body: { currentPassword: pw, newPassword: newPw },
});
check(
  "a plain member (not an admin) can change their own password",
  changed.status === 200 && !!changed.json?.tokens?.accessToken,
  `got ${changed.status} ${changed.json?.error?.message ?? ""}`
);
check(
  "the response carries a working replacement session",
  (await api("GET", "/documents", { token: changed.json?.tokens?.accessToken }))
    .status === 200
);
check(
  "every OTHER device is signed out (old refresh token is dead)",
  (await api("POST", "/auth/refresh", { body: { refreshToken: pwUserRefresh } }))
    .status === 401
);
check(
  "the old password no longer works",
  (
    await api("POST", "/auth/login", {
      body: { email: emails.pwUser, password: pw },
    })
  ).status === 401
);
check(
  "the new password does",
  (
    await api("POST", "/auth/login", {
      body: { email: emails.pwUser, password: newPw },
    })
  ).status === 200
);

// A platform admin has no organization at all, so this proves the endpoint
// hangs off identity rather than off a workspace.
const platPw = await api("POST", "/auth/password", {
  token: P,
  body: { currentPassword: pw, newPassword: newPw },
});
check(
  "a platform admin, who has no workspace, can change theirs too",
  platPw.status === 200,
  `got ${platPw.status} ${platPw.json?.error?.message ?? ""}`
);

check(
  "an anonymous caller cannot",
  (
    await api("POST", "/auth/password", {
      body: { currentPassword: pw, newPassword: newPw },
    })
  ).status === 401
);

// ---------------------------------------------------------------------------
console.log("\n== cleanup ==");
// Only this run's accounts: every address above ends in -<stamp>@test.dev.
// A blanket '%@test.dev' also wiped the platform admin seeded for the
// Playwright suite, which then silently skipped half its tests.
const { rowCount } = await pool.query(
  `delete from users where email like $1`,
  [`%-${stamp}@test.dev`]
);
const { rowCount: orphanOrgs } = await pool.query(
  `delete from organizations o
    where not exists (select 1 from organization_members m where m.organization_id = o.id)
      and o.created_at > now() - interval '1 hour'`
);
console.log(`  removed ${rowCount} test users, ${orphanOrgs} empty test orgs`);

await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
