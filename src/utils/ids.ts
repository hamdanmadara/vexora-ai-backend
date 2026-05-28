import { randomBytes, randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

export function shortId(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}
