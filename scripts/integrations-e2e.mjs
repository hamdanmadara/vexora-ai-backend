/**
 * Integrations E2E against a running backend (:4010).
 *
 * Uses the REAL Zendesk creds from .env, entered through the new per-user
 * flow under a fresh account — then simulates a webhook delivery for a REAL
 * Sunshine conversation and verifies the AI reply landed back in Zendesk.
 */
import "dotenv/config";

const B = process.env.API ?? "http://localhost:4010/api";
const SUNSHINE = process.env.ZENDESK_API_BASE_URL ?? "https://api.smooch.io/v2";
const ENV_CREDS = {
  appId: process.env.ZENDESK_APP_ID,
  keyId: process.env.ZENDESK_API_KEY_ID,
  keySecret: process.env.ZENDESK_API_KEY_SECRET,
  webhookSecret: process.env.ZENDESK_WEBHOOK_SECRET,
};

let pass = 0;
let fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${B}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

function sunshineAuth() {
  return `Basic ${Buffer.from(`${ENV_CREDS.keyId}:${ENV_CREDS.keySecret}`).toString("base64")}`;
}

// --- fresh account -----------------------------------------------------------
console.log("-- account --");
const email = `zdint-${Date.now()}@test.dev`;
const su = await api("POST", "/auth/signup", {
  body: {
    email,
    password: "password789",
    name: "Zd Integrator",
    companyName: "ProLabs Demo",
    companyDescription: "Testing per-user Zendesk integration",
  },
});
check("signup", su.status === 201, `got ${su.status}`);
const TOK = su.json.tokens.accessToken;
// Integrations belong to the ORGANIZATION (the tenant), not the user.
const ORG_ID = su.json.organization.id;

// --- catalog + validation paths ---------------------------------------------
console.log("\n-- integrations API --");
const cat = await api("GET", "/integrations", { token: TOK });
check("catalog lists zendesk with 4 fields",
  cat.status === 200 &&
  cat.json.catalog.some((p) => p.id === "zendesk" && p.fields.length === 4),
  JSON.stringify(cat.json?.catalog?.map?.((p) => p.id)));
check("no integrations connected yet", cat.json.connected.length === 0);

const badShape = await api("PUT", "/integrations/zendesk", {
  token: TOK, body: { appId: "x" },
});
check("short/missing fields -> 400", badShape.status === 400, `got ${badShape.status}`);

const badCreds = await api("PUT", "/integrations/zendesk", {
  token: TOK,
  body: {
    appId: ENV_CREDS.appId,
    keyId: "app_0000000000000000000000",
    keySecret: "wrong-secret-wrong-secret-wrong",
    webhookSecret: "some-webhook-secret-that-is-long",
  },
});
check("live verify rejects wrong keys -> 400 with clear error",
  badCreds.status === 400 && /rejected|Invalid|401|key/i.test(badCreds.json?.error?.message ?? ""),
  `${badCreds.status} ${badCreds.json?.error?.message}`);

const put = await api("PUT", "/integrations/zendesk", { token: TOK, body: ENV_CREDS });
check("real creds verify + save -> 201", put.status === 201, `got ${put.status} ${JSON.stringify(put.json?.error ?? "")}`);
const integ = put.json?.integration;
console.log("  webhookUrl:", integ?.webhookUrl);
check("webhook URL is tokenized", /\/api\/channels\/zendesk\/webhook\/[A-Za-z0-9_-]{30,}$/.test(integ?.webhookUrl ?? ""));
check("secret fields are masked", /^••••/.test(integ?.credentials?.keySecret ?? ""),
  JSON.stringify(integ?.credentials));
check("verify() captured app metadata", typeof integ?.metadata?.subdomain === "string",
  JSON.stringify(integ?.metadata));

// Token from the URL for webhook simulation (localhost URL differs from prod origin — fine).
const webhookToken = (integ?.webhookUrl ?? "").split("/").pop();

// --- encryption at rest ------------------------------------------------------
console.log("\n-- encryption at rest --");
{
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  const { rows } = await pool.query(
    `select credentials from integrations where tenant_id = $1`,
    [ORG_ID]
  );
  const stored = rows[0]?.credentials ?? "";
  check("stored blob is v1.<iv>.<tag>.<ct>", /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(stored));
  check("plaintext secret NOT in DB", !stored.includes(ENV_CREDS.keySecret));
  await pool.end();
}

// --- webhook auth boundaries -------------------------------------------------
console.log("\n-- webhook auth --");
const fakeEvent = (convId, msgId, text) => ({
  events: [{
    type: "conversation:message",
    payload: {
      conversation: { id: convId },
      message: {
        id: msgId,
        author: { type: "user", displayName: "E2E Customer" },
        content: { type: "text", text },
      },
    },
  }],
});

const wrongToken = await fetch(`${B}/channels/zendesk/webhook/not-a-real-token`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": ENV_CREDS.webhookSecret },
  body: JSON.stringify(fakeEvent("c1", "m1", "hi")),
});
check("unknown token -> 401", wrongToken.status === 401, `got ${wrongToken.status}`);

const wrongKey = await fetch(`${B}/channels/zendesk/webhook/${webhookToken}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": "wrong-secret" },
  body: JSON.stringify(fakeEvent("c1", "m2", "hi")),
});
check("valid token + wrong x-api-key -> 401", wrongKey.status === 401, `got ${wrongKey.status}`);

// --- true end-to-end: real conversation, real reply --------------------------
// Sunshine v2 can't list conversations without a user filter, so create a
// dedicated user + conversation for this run (deleted in cleanup below).
console.log("\n-- end to end (real Sunshine conversation) --");
const externalUserId = `vexora-e2e-${Date.now()}`;
const userRes = await fetch(`${SUNSHINE}/apps/${ENV_CREDS.appId}/users`, {
  method: "POST",
  headers: { Authorization: sunshineAuth(), "Content-Type": "application/json" },
  body: JSON.stringify({ externalId: externalUserId, profile: { givenName: "E2E", surname: "Customer" } }),
});
check("created Sunshine test user", userRes.status === 201, `got ${userRes.status}`);

const convCreate = await fetch(`${SUNSHINE}/apps/${ENV_CREDS.appId}/conversations`, {
  method: "POST",
  headers: { Authorization: sunshineAuth(), "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "personal",
    participants: [{ userExternalId: externalUserId }],
  }),
});
const convBody = await convCreate.json();
const convId = convBody?.conversation?.id;
check("created Sunshine test conversation", convCreate.status === 201 && !!convId,
  `${convCreate.status} ${JSON.stringify(convBody).slice(0, 160)}`);
console.log("  using conversation:", convId);

const msgId = `e2e-${Date.now()}`;
const question = "What is 2 + 2? Reply with just the number.";
const before = Date.now();
const hook = await fetch(`${B}/channels/zendesk/webhook/${webhookToken}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": ENV_CREDS.webhookSecret },
  body: JSON.stringify(fakeEvent(convId, msgId, question)),
});
check("webhook accepted -> 200", hook.status === 200, `got ${hook.status}`);

// Processing is async after the ack; poll Sunshine for a NEW business message.
let replied = null;
for (let i = 0; i < 30 && !replied; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const msgsRes = await fetch(
    `${SUNSHINE}/apps/${ENV_CREDS.appId}/conversations/${convId}/messages?page[size]=10`,
    { headers: { Authorization: sunshineAuth() } }
  );
  const msgs = (await msgsRes.json()).messages ?? [];
  replied = msgs
    .reverse()
    .find(
      (m) =>
        m.author?.type === "business" &&
        new Date(m.received).getTime() > before - 5000
    );
}
check("AI reply delivered into the REAL Zendesk conversation", !!replied);
if (replied) console.log(`  bot replied: "${(replied.content?.text ?? "").slice(0, 120)}"`);

// --- tenant mapping ----------------------------------------------------------
console.log("\n-- tenant mapping --");
const month = new Date().toISOString().slice(0, 7);
const an = await api("GET", `/analytics/overview?month=${month}`, { token: TOK });
const zdChannel = (an.json?.channels ?? []).find((c) => c.channel === "zendesk");
check("conversation landed in the NEW user's workspace analytics",
  (zdChannel?.conversations ?? 0) >= 1, JSON.stringify(an.json?.channels));

const integAfter = await api("GET", "/integrations", { token: TOK });
check("last_event_at recorded", !!integAfter.json?.connected?.[0]?.lastEventAt,
  JSON.stringify(integAfter.json?.connected?.[0]?.lastEventAt));

// --- rotate + delete ---------------------------------------------------------
console.log("\n-- rotate & lifecycle --");
const rot = await api("POST", "/integrations/zendesk/rotate-webhook", { token: TOK });
const newToken = (rot.json?.integration?.webhookUrl ?? "").split("/").pop();
check("rotate returns a NEW token", rot.status === 200 && newToken && newToken !== webhookToken);

const oldAfterRotate = await fetch(`${B}/channels/zendesk/webhook/${webhookToken}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": ENV_CREDS.webhookSecret },
  body: JSON.stringify(fakeEvent(convId, "m-old", "hi")),
});
check("OLD token dead after rotate -> 401", oldAfterRotate.status === 401, `got ${oldAfterRotate.status}`);

// --- cleanup the Sunshine test user (removes its conversation too) -----------
const del = await fetch(
  `${SUNSHINE}/apps/${ENV_CREDS.appId}/users/${externalUserId}/personalinformation`,
  { method: "DELETE", headers: { Authorization: sunshineAuth() } }
).catch(() => null);
const delUser = await fetch(
  `${SUNSHINE}/apps/${ENV_CREDS.appId}/users/${externalUserId}`,
  { method: "DELETE", headers: { Authorization: sunshineAuth() } }
).catch(() => null);
console.log(
  `\ncleanup: sunshine user delete -> ${delUser?.status ?? "n/a"} (pi ${del?.status ?? "n/a"})`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
