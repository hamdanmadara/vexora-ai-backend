import "dotenv/config";
import { z } from "zod";

/**
 * Centralised environment configuration.
 *
 * Required vars are validated at boot, but we are lenient with vars that
 * are only needed by certain features (e.g. Google OAuth). Those are
 * stored as optional and checked lazily by the service that needs them.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required").optional(),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o-mini"),
  /** Optional stronger model for scheduling (defaults to OPENAI_CHAT_MODEL). */
  OPENAI_SCHEDULER_MODEL: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional()
  ),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_DB_URL: z.string().optional(),

  // Google
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z
    .string()
    .default("http://localhost:4000/api/auth/google/callback"),
  DEFAULT_SALES_REP_ID: z.string().default("default"),
  /** IANA timezone for the sales rep's calendar (working hours), not the customer's. */
  SALES_TIMEZONE: z.string().default("America/New_York"),

  // RAG
  KNOWLEDGE_INDEX_NAME: z.string().default("vexora_knowledge"),
  RAG_TOP_K: z.coerce.number().int().positive().default(5),
  RAG_CHUNK_SIZE: z.coerce.number().int().positive().default(512),
  RAG_CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(64),

  // Company / branding — this is the company the chatbot represents to the
  // customer. Leave unset (or blank) to keep the bot generic ("our team",
  // "we", ...). When set, agents will use this name in greetings and CTAs.
  COMPANY_NAME: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  COMPANY_DESCRIPTION: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional()
  ),
});

function emptyToUndefined(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "Invalid environment configuration:",
    parsed.error.flatten().fieldErrors
  );
  process.exit(1);
}

export const env: Env = parsed.data;

export const featureFlags = {
  openaiReady: !!env.OPENAI_API_KEY,
  supabaseReady:
    !!env.SUPABASE_URL &&
    !!env.SUPABASE_SERVICE_ROLE_KEY &&
    !!env.SUPABASE_DB_URL,
  googleReady: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
} as const;
