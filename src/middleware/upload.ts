import multer from "multer";
import { BadRequestError } from "@/utils/errors";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const ALLOWED_MIMETYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/octet-stream", // some browsers
]);

const ALLOWED_EXTS = /\.(pdf|doc|docx|txt|md|csv)$/i;

export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 10 },
  fileFilter: (_req, file, cb) => {
    const okMime = ALLOWED_MIMETYPES.has(file.mimetype);
    const okExt = ALLOWED_EXTS.test(file.originalname);
    if (okMime || okExt) {
      cb(null, true);
    } else {
      cb(
        new BadRequestError(
          `Unsupported file type: ${file.originalname} (${file.mimetype})`
        )
      );
    }
  },
});
