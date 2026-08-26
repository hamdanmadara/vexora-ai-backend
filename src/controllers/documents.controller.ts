import type { Request, Response } from "express";
import {
  createDocumentRow,
  deleteDocument,
  getDocument,
  ingestDocument,
  listDocuments,
} from "@/services/document/document.service";
import { BadRequestError } from "@/utils/errors";
import { logger } from "@/utils/logger";
import { authOf } from "@/middleware/require-auth";

function serializeDocument(doc: Awaited<ReturnType<typeof getDocument>>) {
  return {
    id: doc.id,
    name: doc.name,
    mimeType: doc.mime_type,
    sizeBytes: Number(doc.size_bytes),
    status: doc.status,
    chunkCount: doc.chunk_count,
    charCount: doc.char_count,
    error: doc.error,
    uploadedAt: doc.uploaded_at,
    updatedAt: doc.updated_at,
  };
}

export async function uploadDocuments(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    throw new BadRequestError("No files were uploaded. Use field name 'files'.");
  }

  const created = await Promise.all(
    files.map(async (file) => {
      const row = await createDocumentRow({
        name: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        tenantId: userId,
      });

      // Kick off ingestion in the background. We don't await it so the
      // client gets a fast response and can poll for status.
      void ingestDocument({
        documentId: row.id,
        buffer: file.buffer,
        filename: file.originalname,
        mimetype: file.mimetype,
        tenantId: userId,
      }).catch((err) =>
        logger.error({ err, documentId: row.id }, "Background ingestion failed")
      );

      return serializeDocument(row);
    })
  );

  res.status(202).json({ documents: created });
}

export async function listAllDocuments(
  req: Request,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const docs = await listDocuments(userId);
  res.json({ documents: docs.map(serializeDocument) });
}

export async function getOneDocument(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const id = String(req.params.id ?? "");
  if (!id) throw new BadRequestError("Missing document id");
  const doc = await getDocument(id, userId);
  res.json({ document: serializeDocument(doc) });
}

export async function removeDocument(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  const { userId } = authOf(req);
  const id = String(req.params.id ?? "");
  if (!id) throw new BadRequestError("Missing document id");
  await deleteDocument(id, userId);
  res.json({ ok: true });
}
