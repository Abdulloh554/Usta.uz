/**
 * The error hierarchy every layer throws. A service never builds an HTTP
 * response itself — it throws one of these, and the error middleware is the one
 * place that decides status code, body shape and what gets logged.
 */

export type ErrorDetail = {
  field: string;
  message: string;
};

export class ApiError extends Error {
  public readonly statusCode: number;

  public readonly code: string;

  public readonly details: ErrorDetail[];

  /** `false` marks a programmer error — those are logged with a stack and never leak detail. */
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: ErrorDetail[] = [],
    isOperational = true,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, new.target);
  }
}

export class BadRequestError extends ApiError {
  constructor(message = 'Invalid request', details: ErrorDetail[] = [], code = 'BAD_REQUEST') {
    super(400, code, message, details);
  }
}

export class ValidationError extends ApiError {
  constructor(details: ErrorDetail[], message = 'Validation failed') {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'You do not have access to this resource', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends ApiError {
  constructor(resource = 'Resource', code = 'NOT_FOUND') {
    super(404, code, `${resource} not found`);
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Resource already exists', code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class TooManyRequestsError extends ApiError {
  constructor(message = 'Too many requests, please try again later', code = 'TOO_MANY_REQUESTS') {
    super(429, code, message);
  }
}

export class PaymentRequiredError extends ApiError {
  constructor(message = 'Insufficient balance', code = 'PAYMENT_REQUIRED') {
    super(402, code, message);
  }
}

export class InternalError extends ApiError {
  constructor(message = 'Internal server error', code = 'INTERNAL_ERROR') {
    super(500, code, message, [], false);
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Upstream service unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(503, code, message);
  }
}
