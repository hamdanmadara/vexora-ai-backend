/**
 * Helpers for turning Mastra stream chunks into customer-safe text.
 */

const DELEGATION_MARKERS = [
  "recipient_name",
  "functions.agent-",
  "agent-knowledge",
  "agent-greeter",
  "agent-scheduler",
  '"parameters"',
  "suspendedToolRunId",
] as const;

/** True when a text chunk is internal routing / tool-call JSON, not a reply. */
export function isInternalStreamText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const lower = trimmed.toLowerCase();
    if (DELEGATION_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
      return true;
    }
    // Large JSON blobs are never user-facing copy.
    if (trimmed.length > 80 && trimmed.includes('"prompt"')) return true;
  }

  if (trimmed.startsWith("[Delegation Rejected]")) return true;

  return false;
}

type StreamChunk = {
  type: string;
  payload?: {
    text?: string;
    type?: string;
    payload?: { text?: string };
  };
};

/**
 * Extract user-visible text from a Mastra fullStream chunk.
 * Returns null for chunks that should not be shown to the customer.
 */
export function extractCustomerText(chunk: StreamChunk): string | null {
  if (chunk.type === "text-delta") {
    const text = chunk.payload?.text ?? "";
    return isInternalStreamText(text) ? null : text;
  }

  // Nested sub-agent events (supervisor / network paths).
  if (chunk.type.startsWith("agent-execution-event-")) {
    const inner = chunk.payload;
    if (inner?.type === "text-delta" && inner.payload?.text) {
      const text = inner.payload.text;
      return isInternalStreamText(text) ? null : text;
    }
  }

  return null;
}
