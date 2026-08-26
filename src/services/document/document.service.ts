import { getPool } from "@/db/pool";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";
import { NotFoundError } from "@/utils/errors";
import { ensureKnowledgeIndex, getVectorStore } from "@/mastra/vector";
import { parseDocument } from "./parser";
import { chunkDocument } from "./chunker";
import { embedTexts } from "./embedder";

export type DocumentStatus = "queued" | "processing" | "ready" | "failed";

export interface DocumentRow {
  id: string;
  tenant_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  chunk_count: number;
  char_count: number;
  error: string | null;
  uploaded_at: string;
  updated_at: string;
}

const DEFAULT_TENANT = "default";

export async function listDocuments(
  tenantId: string = DEFAULT_TENANT
): Promise<DocumentRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<DocumentRow>(
    `select * from documents where tenant_id = $1 order by uploaded_at desc`,
    [tenantId]
  );
  return rows;
}

/**
 * Fetch one document. When tenantId is given, ownership is part of the
 * lookup — another tenant's document 404s rather than 403s, so the API
 * never confirms that a given id exists in someone else's workspace.
 */
export async function getDocument(
  id: string,
  tenantId?: string
): Promise<DocumentRow> {
  const pool = getPool();
  const { rows } = await pool.query<DocumentRow>(
    tenantId
      ? `select * from documents where id = $1 and tenant_id = $2`
      : `select * from documents where id = $1`,
    tenantId ? [id, tenantId] : [id]
  );
  const doc = rows[0];
  if (!doc) throw new NotFoundError(`Document ${id} not found`);
  return doc;
}

export async function createDocumentRow(input: {
  name: string;
  mimeType: string;
  sizeBytes: number;
  tenantId?: string;
}): Promise<DocumentRow> {
  const pool = getPool();
  const { rows } = await pool.query<DocumentRow>(
    `insert into documents (tenant_id, name, mime_type, size_bytes, status)
     values ($1, $2, $3, $4, 'queued') returning *`,
    [
      input.tenantId ?? DEFAULT_TENANT,
      input.name,
      input.mimeType,
      input.sizeBytes,
    ]
  );
  return rows[0]!;
}

export async function updateDocumentStatus(
  id: string,
  status: DocumentStatus,
  patch: { chunkCount?: number; charCount?: number; error?: string | null } = {}
): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `update documents
       set status = $2,
           chunk_count = coalesce($3, chunk_count),
           char_count  = coalesce($4, char_count),
           error       = $5
     where id = $1`,
    [
      id,
      status,
      patch.chunkCount ?? null,
      patch.charCount ?? null,
      patch.error ?? null,
    ]
  );
  if (result.rowCount === 0) {
    logger.warn(
      { documentId: id, status },
      "updateDocumentStatus matched 0 rows — document row missing"
    );
  }
}

/**
 * Recover documents that were left in a pending state because the server
 * was restarted (or crashed) mid-ingestion. We can't resume the in-memory
 * buffer, so the safest thing is to mark them as failed and let the user
 * retry by re-uploading.
 */
export async function recoverPendingDocuments(): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `update documents
        set status = 'failed',
            error = 'Ingestion interrupted (server restarted). Please re-upload.'
      where status in ('queued', 'processing')`
  );
  return rowCount ?? 0;
}

export async function deleteDocument(
  id: string,
  tenantId?: string
): Promise<void> {
  const doc = await getDocument(id, tenantId);
  const pool = getPool();
  const store = getVectorStore();

  // Remove vectors first. We stored documentId in metadata; PgVector
  // doesn't have an atomic deleteByFilter API across versions, so we
  // fetch matching ids by metadata then delete.
  try {
    // PgVector's deleteIndexById signature varies between versions;
    // the cross-version-safe approach is to issue a SQL DELETE on the
    // underlying table using the indexName + metadata->>documentId.
    const pgPool = getPool();
    await pgPool.query(
      `delete from ${env.KNOWLEDGE_INDEX_NAME} where metadata->>'documentId' = $1`,
      [id]
    );
  } catch (err) {
    logger.warn({ err, documentId: id }, "Failed to clean vectors for document");
  }

  await pool.query(`delete from documents where id = $1`, [id]);

  // Acknowledge store import so it isn't tree-shaken away when delete API arrives.
  void store;
  void doc;
}

/**
 * The full ingestion pipeline. Runs asynchronously after upload.
 *   parse -> chunk -> embed -> upsert into vector store -> mark ready
 */
export async function ingestDocument(args: {
  documentId: string;
  buffer: Buffer;
  filename: string;
  mimetype: string;
  tenantId?: string;
}): Promise<void> {
  const { documentId, buffer, filename, mimetype } = args;
  const tenantId = args.tenantId ?? DEFAULT_TENANT;

  try {
    await updateDocumentStatus(documentId, "processing");
    await ensureKnowledgeIndex();

    const parsed = await parseDocument(buffer, filename, mimetype);
    if (!parsed.text.trim()) {
      throw new Error("Document is empty or could not be parsed.");
    }

    const chunks = await chunkDocument(parsed.text, {
      source: filename,
      mimeType: mimetype,
    });

    if (chunks.length === 0) {
      throw new Error("No usable chunks extracted from document.");
    }

    const embeddings = await embedTexts(chunks.map((c) => c.text));

    const store = getVectorStore();
    await store.upsert({
      indexName: env.KNOWLEDGE_INDEX_NAME,
      vectors: embeddings,
      metadata: chunks.map((c, i) => ({
        text: c.text,
        documentId,
        tenantId,
        source: filename,
        chunkIndex: i,
        ...(c.metadata ?? {}),
      })),
    });

    await updateDocumentStatus(documentId, "ready", {
      chunkCount: chunks.length,
      charCount: parsed.text.length,
      error: null,
    });

    logger.info(
      { documentId, filename, chunks: chunks.length },
      "Document ingested"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, documentId, filename }, "Document ingestion failed");
    await updateDocumentStatus(documentId, "failed", { error: message });
  }
}
