/**
 * Extract plain text from Mastra message content for API / UI display.
 */

type ContentPart = {
  type?: string;
  text?: string;
  reasoning?: string;
  toolInvocation?: { result?: unknown; state?: string };
};

function cleanUserFacingText(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^User question:\s*/i, "");
  text = text.replace(/^Respond as a member of our company team.*$/ims, "").trim();
  text = text.replace(/^['"]+|['"]+$/g, "").trim();
  return text;
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";

  const obj = content as {
    content?: unknown;
    parts?: ContentPart[];
    format?: number;
  };

  if (Array.isArray(obj.parts)) {
    const chunks: string[] = [];
    for (const part of obj.parts) {
      if (!part) continue;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        chunks.push(cleanUserFacingText(part.text));
      }
      if (part.type === "reasoning" && typeof part.reasoning === "string" && part.reasoning.trim()) {
        chunks.push(part.reasoning.trim());
      }
      if (part.type === "tool-invocation" && part.toolInvocation?.state === "result") {
        const result = part.toolInvocation.result;
        if (typeof result === "string" && result.trim()) chunks.push(result.trim());
      }
    }
    if (chunks.length) return chunks.join("\n\n");
  }

  if (typeof obj.content === "string") return obj.content.trim();
  if (Array.isArray(obj.content)) {
    return (obj.content as ContentPart[])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("");
  }

  return "";
}
