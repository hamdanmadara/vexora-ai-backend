const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PH_START = "\uE000";

/**
 * Fixes missing spaces when LLM streaming splits tokens without leading spaces.
 * Never mutates email addresses or URLs.
 */
export function normalizeAssistantText(text: string): string {
  if (!text) return text;

  const emails: string[] = [];
  const urls: string[] = [];

  let out = text.replace(EMAIL_RE, (m) => {
    emails.push(m);
    return PH_START + String.fromCharCode(0xe100 + emails.length - 1);
  });

  out = out.replace(/https?:\/\/[^\s]+/g, (m) => {
    urls.push(m);
    return PH_START + String.fromCharCode(0xe200 + urls.length - 1);
  });

  out = out.replace(/\b([A-Z])\s+(\d)\s+([A-Z])\b/g, "$1$2$3");
  out = out.replace(/([a-zA-Z])(\d)/g, "$1 $2");
  out = out.replace(/(\d)([A-Za-z]{2,})/g, "$1 $2");
  out = out.replace(/(\d{4}-\d{2}-\d{2}),(\d)/g, "$1, $2");
  out = out.replace(/\b(AM|PM|Pkt|PKT)([A-Za-z])/g, "$1 $2");
  out = out.replace(/(\d{1,2})\s+th\b/gi, "$1th");
  out = out.replace(/\)\s*(\d{1,2})\)/g, ")\n$1)");
  out = out.replace(/(PM|AM)(\d{1,2})\)/gi, "$1\n$2)");

  for (let i = 0; i < emails.length; i++) {
    out = out.replace(
      PH_START + String.fromCharCode(0xe100 + i),
      emails[i]
    );
  }
  for (let i = 0; i < urls.length; i++) {
    out = out.replace(
      PH_START + String.fromCharCode(0xe200 + i),
      urls[i]
    );
  }

  // NOTE: never re-touch URLs after restoring them — a greedy pattern like
  // /(https?:\/\/\S+)([A-Za-z])/ backtracks INTO the URL and injects a space
  // before its last letter (broke Google Meet links).
  out = out.replace(/(\d+)\s*-\s*(minute|min|hour|hr)/gi, "$1-$2");

  out = out.replace(
    /([.!?])\s*(Video link:|Meet link:|Meeting link:)\s*(https?:\/\/)/gi,
    "$1\n\n$2 $3"
  );
  out = out.replace(
    /([.!?])\s*(https?:\/\/meet\.google\.com\/[^\s]+)/gi,
    "$1\n\n$2"
  );

  return out;
}
