import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { ApiError, type ErrorDetail, NotFoundError } from '../errors/ApiError';
import { logger } from '../../config/logger';
import { isProduction } from '../../config/env';

const zodDetails = (error: ZodError): ErrorDetail[] =>
  error.issues.map((issue) => ({
    field: issue.path.join('.') || '_root',
    message: issue.message,
  }));

const mongooseDetails = (error: mongoose.Error.ValidationError): ErrorDetail[] =>
  Object.values(error.errors).map((issue) => ({
    field: issue.path,
    message: issue.message,
  }));

const isDuplicateKey = (error: unknown): error is { code: number; keyValue: Record<string, unknown> } =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;

/** Terminal 404 — mounted after every route so an unmatched path is a real error. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
};

/**
 * The single place an error becomes an HTTP response. Anything that is not an
 * `ApiError` is normalised here, and only operational errors keep their message
 * in production — an unexpected throw must not leak internals to a client.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let apiError: ApiError;

  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof ZodError) {
    apiError = new ApiError(422, 'VALIDATION_ERROR', 'Validation failed', zodDetails(error));
  } else if (error instanceof mongoose.Error.ValidationError) {
    apiError = new ApiError(422, 'VALIDATION_ERROR', 'Validation failed', mongooseDetails(error));
  } else if (error instanceof mongoose.Error.CastError) {
    apiError = new ApiError(400, 'INVALID_ID', `Invalid value for ${error.path}`, [
      { field: error.path, message: 'invalid_id' },
    ]);
  } else if (isDuplicateKey(error)) {
    const field = Object.keys(error.keyValue)[0] ?? 'field';
    apiError = new ApiError(409, 'DUPLICATE_KEY', `${field} is already in use`, [
      { field, message: 'duplicate' },
    ]);
  } else {
    const message = error instanceof Error ? error.message : 'Internal server error';
    apiError = new ApiError(500, 'INTERNAL_ERROR', message, [], false);
  }

  const context = {
    method: req.method,
    path: req.originalUrl,
    status: apiError.statusCode,
    code: apiError.code,
    userId: (req as { user?: { id: string } }).user?.id,
  };

  if (!apiError.isOperational || apiError.statusCode >= 500) {
    logger.error(apiError.message, {
      ...context,
      stack: error instanceof Error ? error.stack : undefined,
    });
  } else {
    logger.warn(apiError.message, context);
  }

  const exposeMessage = apiError.isOperational || !isProduction;

  res.status(apiError.statusCode).json({
    success: false,
    error: {
      code: apiError.code,
      message: exposeMessage ? apiError.message : 'Internal server error',
      ...(apiError.details.length ? { details: apiError.details } : {}),
    },
  });
};
