import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import type { Log } from "../core/types";

/**
 * Throw from a route handler to send an error response with a specific
 * status. The message is always sent to the client, so keep it safe to show.
 *
 * @example
 * throw new HttpError(404, "User not found", { code: "USER_NOT_FOUND" });
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    status: number,
    message: string,
    options: { code?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "HttpError";
    this.status = status;
    this.code = options.code;
    this.details = options.details;
  }
}

/**
 * The error envelope used by every built-in error response.
 */
export function errorBody(
  req: Request,
  message: string,
  extra: { code?: string; details?: unknown } = {},
) {
  return { isSuccess: false as const, message, ...extra, requestId: req.id };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(errorBody(req, "Not found"));
};

type ExposableError = Error & {
  status?: number;
  statusCode?: number;
  expose?: boolean;
  type?: string;
};

/**
 * Final error middleware. HttpErrors and client errors from Express/body
 * parsing keep their status and message; anything else becomes a 500 with a
 * generic message, and the real error is logged.
 */
export function createErrorHandler(fallbackLog: Log): ErrorRequestHandler {
  return (err: ExposableError, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof HttpError) {
      res
        .status(err.status)
        .json(
          errorBody(req, err.message, { code: err.code, details: err.details }),
        );
      return;
    }

    if (err.type === "entity.parse.failed") {
      res.status(400).json(errorBody(req, "Invalid JSON in request body"));
      return;
    }

    const status = err.status ?? err.statusCode;
    if (status && status >= 400 && status < 500 && err.expose !== false) {
      res.status(status).json(errorBody(req, err.message));
      return;
    }

    (req.log ?? fallbackLog).error(
      `Unhandled error on ${req.method} ${req.originalUrl}: ${err.stack ?? err}`,
    );
    res.status(500).json(errorBody(req, "Internal server error"));
  };
}
