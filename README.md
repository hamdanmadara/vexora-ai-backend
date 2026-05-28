# Vexora AI — Backend

The API and agent runtime for **Vexora AI**, a B2B sales chatbot that:

- Talks with leads on web (and later WhatsApp / Messenger)
- Answers using a knowledge base of uploaded documents (RAG on Supabase pgvector)
- Detects buying intent and books meetings on **Google Meet** via Google Calendar

## Stack

- **Express** + **TypeScript** (Node 20+)
- **Mastra** for agents (supervisor + 3 specialists)
- **Supabase Postgres** for application data, conversation memory, and pgvector for RAG
- **Google Calendar API** (OAuth 2.0) for Meet scheduling
- **OpenAI** for chat (`gpt-5-mini`) and embeddings (`text-embedding-3-small`)

## Architecture in 30 seconds

```
client → POST /api/chat → ChatService → Supervisor Agent
                                        ├── Greeter         (small talk)
                                        ├── Knowledge        (RAG over pgvector)
                                        └── Scheduler        (Google Meet booking)
```

Each agent has a single, focused prompt. Tools are tiny, typed (Zod) functions
that wrap real services. Conversation history lives in Mastra Memory backed by
Supabase Postgres so it survives restarts.

## Folder structure

```
src/
├── config/         env validation (Zod) and feature flags
├── controllers/    thin request handlers (parse → call service → respond)
├── db/             pg Pool + SQL migrations + migration runner
├── mastra/
│   ├── agents/     supervisor + greeter + knowledge + scheduler
│   ├── tools/      searchKnowledge, updateLead, proposeSlots, bookMeeting
│   ├── memory.ts   Mastra Memory wired to Postgres
│   ├── vector.ts   Mastra PgVector for the knowledge index
│   └── model.ts    central OpenAI model factory
├── middleware/     error handler, async handler, multer, pino-http logger
├── routes/         /health, /documents, /chat, /auth/google
├── services/
│   ├── chat/       streamChat() + generateChat()
│   ├── document/   parser, chunker, embedder, ingestion pipeline
│   ├── google/     OAuth + Calendar + credentials persistence
│   └── lead/       lead CRUD
├── utils/          logger, errors, ids, validators
├── app.ts          Express app factory (CORS, JSON, routes, errors)
└── server.ts       bootstrap (migrations + listen + signal handling)
```

## Setup

### 1. Install

```bash
cd backend
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env
```

Fill in the values you have. The server boots even if some are missing — the
`/api/health` endpoint will report which features are disabled.

Required for full functionality:

| Variable                   | Where to get it                                                          |
| -------------------------- | ------------------------------------------------------------------------ |
| `OPENAI_API_KEY`           | https://platform.openai.com/api-keys                                     |
| `SUPABASE_URL`             | Supabase Dashboard → Project Settings → API → Project URL                |
| `SUPABASE_SERVICE_ROLE_KEY`| Supabase Dashboard → Project Settings → API → service_role key (SECRET!) |
| `SUPABASE_DB_URL`          | Supabase Dashboard → Settings → Database → Connection string (URI)       |
| `GOOGLE_CLIENT_ID`         | Google Cloud Console → APIs & Services → Credentials                     |
| `GOOGLE_CLIENT_SECRET`     | (same)                                                                   |

> **Supabase DB URL tip.** Use the direct connection string on **port 5432** or the
> "Session pooler". Do **NOT** use the Transaction pooler (port 6543) — it doesn't
> support prepared statements that Mastra and `pg` rely on.

> **Supabase pgvector.** The migration enables the `vector` extension
> automatically on first boot, but if your tier doesn't allow extensions from
> SQL, enable it once from the Dashboard: Database → Extensions → search "vector".

### 3. Run

```bash
npm run dev
```

You'll see something like:

```
Vexora backend ready → http://localhost:4000
```

### 4. Connect Google (one-time, for the sales rep)

Open in a browser:

```
http://localhost:4000/api/auth/google/connect
```

Approve the consent screen. You'll be redirected to a "Google connected!" page.
The refresh token is persisted in `google_credentials`. The bot can now book
meetings for this Google account forever (until you revoke).

Check status anytime:

```
GET http://localhost:4000/api/auth/google/status
```

## API

### Health

```
GET /api/health
```

Returns service status + which features are configured.

### Documents (knowledge base)

```
POST   /api/documents          multipart, field name: files (up to 10 at once)
GET    /api/documents
GET    /api/documents/:id
DELETE /api/documents/:id
```

Upload is asynchronous: response is `202 Accepted` with the new rows in
`status="queued"`. Ingestion (parse → chunk → embed → upsert) runs in the
background. Poll `GET /api/documents` until each row reaches `status="ready"`.

Supported file types: PDF, DOCX, TXT, MD, CSV. Max 25 MB per file.

### Chat

```
POST   /api/chat               Server-Sent Events stream by default
GET    /api/chat/:sessionId    fetch lead profile + conversation history
DELETE /api/chat/:sessionId    clear a session
```

Request body:

```json
{
  "sessionId": "anything-unique-per-conversation",
  "message": "Hi, do you support Zoom?",
  "channel": "web",
  "stream": true
}
```

SSE events emitted:

- `event: delta` — `{ "content": "partial text" }`
- `event: done` — `{ "ok": true }`
- `event: error` — `{ "message": "..." }`

Set `stream: false` in the body for a single JSON response (`{ reply }`).

### Google auth

```
GET /api/auth/google/connect    starts OAuth flow
GET /api/auth/google/callback   Google redirects here
GET /api/auth/google/status     { connected, email }
```

## Scripts

```bash
npm run dev         # tsx watch — instant TS, auto-restart
npm run build       # tsc → dist/
npm run start       # node dist/server.js (after build)
npm run typecheck   # tsc --noEmit
```

## Wiring the frontend

In the frontend, point your fetch calls to:

```
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
```

- Upload: `POST ${BASE}/api/documents` with `FormData` (field name `files`).
- Chat (SSE): `POST ${BASE}/api/chat` with `Accept: text/event-stream` and parse
  the stream chunk-by-chunk.

## Operational notes

- **Graceful degradation**: missing env vars don't crash the server. Each
  feature returns a 503 with a clear message until configured.
- **Background ingestion**: uploads return immediately; ingestion runs async.
  The frontend polls or refreshes the documents list to see status changes.
- **Streaming**: the chat endpoint uses Server-Sent Events. Heartbeats are sent
  every 15s so proxies don't kill the connection.
- **Memory**: Mastra Memory keeps the last 20 messages per session in context
  by default — change in `src/mastra/memory.ts`.
- **Multi-tenant**: every table has a `tenant_id`/`session_id` column. Today
  everything is single-tenant (`tenant_id='default'`); switching to real
  tenants is mostly a matter of plumbing an auth user id into requests.

## Roadmap from here

- WhatsApp + Messenger ingestion (Meta WhatsApp Cloud API + Messenger webhooks)
- Zoom support (mirror the Google flow under `services/zoom`)
- Real Supabase Auth (multi-tenant + RLS)
- Re-ranking with `bge-reranker` for higher RAG accuracy
- A simple admin dashboard for leads + bookings
