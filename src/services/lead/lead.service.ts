import { getPool } from "@/db/pool";

export type LeadStatus =
  | "new"
  | "engaged"
  | "collecting_info"
  | "meeting_proposed"
  | "meeting_booked"
  | "closed";

export interface LeadRow {
  id: string;
  tenant_id: string;
  session_id: string;
  name: string | null;
  email: string | null;
  channel: string;
  status: LeadStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_TENANT = "default";

export async function getOrCreateLead(input: {
  sessionId: string;
  tenantId?: string;
  channel?: string;
}): Promise<LeadRow> {
  const pool = getPool();
  const tenantId = input.tenantId ?? DEFAULT_TENANT;
  const channel = input.channel ?? "web";

  const { rows } = await pool.query<LeadRow>(
    `insert into leads (tenant_id, session_id, channel)
       values ($1, $2, $3)
     on conflict (session_id) do update
       set updated_at = now()
     returning *`,
    [tenantId, input.sessionId, channel]
  );
  return rows[0]!;
}

export async function getLeadBySession(sessionId: string): Promise<LeadRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<LeadRow>(
    `select * from leads where session_id = $1`,
    [sessionId]
  );
  return rows[0] ?? null;
}

export async function updateLead(
  sessionId: string,
  patch: Partial<Pick<LeadRow, "name" | "email" | "status" | "notes">>
): Promise<LeadRow> {
  const pool = getPool();
  const { rows } = await pool.query<LeadRow>(
    `update leads
        set name   = coalesce($2, name),
            email  = coalesce($3, email),
            status = coalesce($4, status),
            notes  = coalesce($5, notes)
      where session_id = $1
      returning *`,
    [
      sessionId,
      patch.name ?? null,
      patch.email ?? null,
      patch.status ?? null,
      patch.notes ?? null,
    ]
  );
  return rows[0]!;
}

/** Wipe lead state when the user clears chat (avoids stale meeting_booked / contact). */
export async function resetLeadForSession(sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `update leads
        set name = null,
            email = null,
            status = 'new',
            notes = $2,
            updated_at = now()
      where session_id = $1`,
    [sessionId, JSON.stringify({ userTurns: 0, meetingOffered: false })]
  );
}
