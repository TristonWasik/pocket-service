import { NextFunction, Request, Response } from "express";
import { Logger } from "winston";

export type Message = {
  type: string;
  userId: string;
  teamId: string;
  timestamp: number;
  payload: Record<string, string | number | boolean | null>;
};
export type ExpressMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;
export type BaseExpressOptions = {
  /**
   * Don't include the default health check and metrics routes.
   */
  omitDefaultRoutes?: boolean;
  /**
   * Whether to parse incoming request bodies as JSON.
   */
  asJson: boolean;
  /**
   * An array of custom Express middleware functions to apply to the Express app globally (before all routes).
   */
  customMiddleware?: ExpressMiddleware[];
  /**
   * Whether to allow CORS requests with credentials (cookies, authorization headers, etc.). This option is only relevant if CORS is enabled via either `corsFn` or `corsWhitelist`.
   */
  credentials?: boolean;
};
export type ExpressOptionsWithCorsFn = BaseExpressOptions & {
  /**
   * A function to determine whether to allow CORS requests from a given origin.
   * @param origin The origin of the request.
   * @param callback A callback function to indicate whether the origin is allowed.
   */
  corsFn: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => void;
};
export type ExpressOptionsWithCorsWhitelist = BaseExpressOptions & {
  /**
   * An array of allowed origins for CORS requests. If the origin of an incoming request is in this whitelist, the request will be allowed.
   */
  corsWhitelist: string[];
};
export type ExpressOptions =
  | ExpressOptionsWithCorsFn
  | ExpressOptionsWithCorsWhitelist;
export type CustomModuleFactory = (log: Logger) => boolean | Promise<boolean>;
export type CustomModules = {
  init: CustomModuleFactory;
  shutdown?: CustomModuleFactory;
  name: string;
}[];
