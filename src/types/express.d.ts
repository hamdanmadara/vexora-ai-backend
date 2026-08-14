/**
 * The raw request body, captured by express.json()'s `verify` option in
 * app.ts. Needed for webhook signature verification (e.g. Zendesk), which
 * must hash the exact bytes the sender signed, not the re-serialized parsed
 * JSON object.
 */
declare namespace Express {
  interface Request {
    rawBody?: Buffer;
  }
}
