import mammoth from "mammoth";
import { BadRequestError } from "@/utils/errors";

export interface ParsedDocument {
  text: string;
  meta: Record<string, unknown>;
}

function extByName(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ?? "";
}

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  // pdf-parse is CJS, so we import dynamically to keep ESM tsc happy.
  const mod = await import("pdf-parse");
  const pdfParse = (mod as unknown as { default: (b: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, unknown> }> }).default;
  const result = await pdfParse(buffer);
  return {
    text: result.text,
    meta: { pages: result.numpages, pdfInfo: result.info },
  };
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value,
    meta: {},
  };
}

function parsePlain(buffer: Buffer): ParsedDocument {
  return { text: buffer.toString("utf8"), meta: {} };
}

/**
 * Convert an uploaded file's buffer into plain text.
 * Picks parser by extension, then mime as a fallback.
 */
export async function parseDocument(
  buffer: Buffer,
  filename: string,
  mimetype: string
): Promise<ParsedDocument> {
  const ext = extByName(filename);

  if (ext === "pdf" || mimetype === "application/pdf") {
    return parsePdf(buffer);
  }
  if (
    ext === "docx" ||
    mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return parseDocx(buffer);
  }
  if (
    ext === "doc" ||
    mimetype === "application/msword"
  ) {
    // Old-school .doc isn't well supported in pure JS — try mammoth, fall back gracefully.
    try {
      return await parseDocx(buffer);
    } catch {
      throw new BadRequestError(
        "Legacy .doc files aren't supported. Please save as .docx and try again."
      );
    }
  }
  if (
    ext === "txt" ||
    ext === "md" ||
    ext === "csv" ||
    mimetype.startsWith("text/")
  ) {
    return parsePlain(buffer);
  }

  // Last resort: best-effort UTF-8 decode.
  try {
    return parsePlain(buffer);
  } catch {
    throw new BadRequestError(`Unsupported file type: ${filename}`);
  }
}
