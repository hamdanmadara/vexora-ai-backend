import { Router } from "express";
import { asyncHandler } from "@/middleware/async-handler";
import { documentUpload } from "@/middleware/upload";
import {
  getOneDocument,
  listAllDocuments,
  removeDocument,
  uploadDocuments,
} from "@/controllers/documents.controller";

export const documentsRouter = Router();

documentsRouter.get("/", asyncHandler(listAllDocuments));
documentsRouter.get("/:id", asyncHandler(getOneDocument));
documentsRouter.post(
  "/",
  documentUpload.array("files", 10),
  asyncHandler(uploadDocuments)
);
documentsRouter.delete("/:id", asyncHandler(removeDocument));
