/**
 * Map common customer phrases to IANA timezones.
 * LLM can also pass full IANA ids directly (e.g. America/New_York).
 */

const ALIASES: Array<{ pattern: RegExp; iana: string }> = [
  { pattern: /\bUS\s+Eastern|Eastern\s+(Time|US)|\bEST\b|\bEDT\b/i, iana: "America/New_York" },
  { pattern: /\bUS\s+Central|Central\s+(Time|US)|\bCST\b|\bCDT\b/i, iana: "America/Chicago" },
  { pattern: /\bUS\s+Mountain|Mountain\s+(Time|US)|\bMST\b|\bMDT\b/i, iana: "America/Denver" },
  { pattern: /\bUS\s+Pacific|Pacific\s+(Time|US)|\bPST\b|\bPDT\b/i, iana: "America/Los_Angeles" },
  { pattern: /\bUK\s+time|British\s+time|\bGMT\b|\bBST\b|\bLondon\b/i, iana: "Europe/London" },
  { pattern: /\bDubai\b|\bGST\b/i, iana: "Asia/Dubai" },
  { pattern: /\bKarachi\b|\bPKT\b|\bPakistan\b/i, iana: "Asia/Karachi" },
  { pattern: /\bIndia\b|\bIST\b|\bMumbai\b|\bDelhi\b/i, iana: "Asia/Kolkata" },
  { pattern: /\bSingapore\b|\bSGT\b/i, iana: "Asia/Singapore" },
  { pattern: /\bUTC\b/i, iana: "UTC" },
];

const IANA_IN_TEXT =
  /\b([A-Za-z]+(?:_[A-Za-z]+)?\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/;

export function extractTimezoneFromText(message: string): string | null {
  const ianaMatch = message.match(IANA_IN_TEXT);
  if (ianaMatch) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: ianaMatch[1] });
      return ianaMatch[1];
    } catch {
      // invalid IANA
    }
  }

  for (const { pattern, iana } of ALIASES) {
    if (pattern.test(message)) return iana;
  }

  return null;
}

export function formatInTimezone(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  });
}

export function timezoneLabel(iana: string): string {
  try {
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return offset ? `${iana} (${offset})` : iana;
  } catch {
    return iana;
  }
}
