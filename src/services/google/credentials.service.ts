import { getPool } from "@/db/pool";

export interface GoogleCredentialsRow {
  sales_rep_id: string;
  access_token: string | null;
  refresh_token: string;
  expiry_date: number | null;
  scope: string | null;
  token_type: string | null;
  google_email: string | null;
  created_at: string;
  updated_at: string;
}

export async function saveGoogleCredentials(input: {
  salesRepId: string;
  accessToken?: string | null;
  refreshToken: string;
  expiryDate?: number | null;
  scope?: string | null;
  tokenType?: string | null;
  googleEmail?: string | null;
}): Promise<GoogleCredentialsRow> {
  const pool = getPool();
  const { rows } = await pool.query<GoogleCredentialsRow>(
    `insert into google_credentials
        (sales_rep_id, access_token, refresh_token, expiry_date,
         scope, token_type, google_email)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (sales_rep_id) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expiry_date = excluded.expiry_date,
        scope = excluded.scope,
        token_type = excluded.token_type,
        google_email = excluded.google_email
     returning *`,
    [
      input.salesRepId,
      input.accessToken ?? null,
      input.refreshToken,
      input.expiryDate ?? null,
      input.scope ?? null,
      input.tokenType ?? null,
      input.googleEmail ?? null,
    ]
  );
  return rows[0]!;
}

export async function getGoogleCredentials(
  salesRepId: string
): Promise<GoogleCredentialsRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<GoogleCredentialsRow>(
    `select * from google_credentials where sales_rep_id = $1`,
    [salesRepId]
  );
  return rows[0] ?? null;
}

export async function updateAccessToken(input: {
  salesRepId: string;
  accessToken: string;
  expiryDate: number;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `update google_credentials
        set access_token = $2, expiry_date = $3
      where sales_rep_id = $1`,
    [input.salesRepId, input.accessToken, input.expiryDate]
  );
}
