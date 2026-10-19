import { randomUUID } from "crypto";
import type { RequestHandler } from "express";
import type { Logger } from "winston";

declare global {
  namespace Express {
    interface Request {
      /** Request ID from `x-request-id`, or a generated UUID. */
      id: string;
      /** Logger that tags every line with this request's ID. */
      log: Logger;
    }
  }
}

const VALID_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * Assigns `req.id` and `req.log`, and echoes the ID in the `x-request-id`
 * response header. An incoming ID is reused only if it is short and contains
 * no unusual characters, so it is safe to log.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get("x-request-id");
    req.id =
      incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", req.id);
    req.log = logger.child({ requestId: req.id });
    next();
  };
}
