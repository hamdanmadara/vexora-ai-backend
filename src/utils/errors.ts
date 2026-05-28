/**
 * Centralised error classes so controllers can throw with intent
 * and the error middleware converts them to clean JSON responses.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super(409, "CONFLICT", message, details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", details?: unknown) {
    super(503, "SERVICE_UNAVAILABLE", message, details);
  }
}

export class FeatureDisabledError extends AppError {
  constructor(feature: string) {
    super(
      503,
      "FEATURE_DISABLED",
      `${feature} is not configured. Check your .env file.`
    );
  }
}
