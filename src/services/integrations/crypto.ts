import crypto from "node:crypto";
import { env, featureFlags } from "@/config/env";
import { FeatureDisabledError } from "@/utils/errors";

/**
 * Credentials-at-rest encryption: AES-256-GCM with a random IV per write.
 * Stored format: `v1.<iv>.<authTag>.<ciphertext>` (all base64url), so the
 * scheme can be versioned if the algorithm ever changes.
 *
 * GCM gives authenticated encryption — a tampered DB row fails decryption
 * loudly instead of yielding garbage credentials.
 */

function key(): Buffer {
  if (!featureFlags.integrationsReady || !env.CREDENTIALS_ENCRYPTION_KEY) {
    throw new FeatureDisabledError(
      "Integrations (set CREDENTIALS_ENCRYPTION_KEY)"
    );
  }
  // Accept base64/base64url or raw text; hash to exactly 32 bytes either
  // way so any sufficiently long env value works.
  return crypto
    .createHash("sha256")
    .update(env.CREDENTIALS_ENCRYPTION_KEY)
    .digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptJson<T>(stored: string): T {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unrecognized encrypted credentials format");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/** URL-safe random token for per-integration webhook URLs (256 bits). */
export function generateWebhookToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** "…last4" display form — the API never returns a stored secret in full. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}
