import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import type { output, ZodType } from "zod";
import { errorBody } from "./errors";
import { rateLimitMiddleware } from "./rate-limit";

export type RouteMeta = {
  description?: string;
  /**
   * Marks the route deprecated in OpenAPI and sends a `Deprecation` header:
   * `true`, or `@<unix seconds>` when a Date (the deprecation date) is given.
   */
  deprecated?: boolean | Date;
  tags?: string[];
  /**
   * Rate-limit tier from `withRateLimits()`. Routes without one use the
   * configured default tier.
   */
  rateLimit?: "standard" | "strict" | "none";
  version?: string;
  [key: string]: any;
};

export type AuthenticatedUser = {
  userId: string;
  [key: string]: string | string[] | number | boolean;
};

export type AuthResolver = (
  req: Request,
  route: AnyRouteDefinition,
) => AuthenticatedUser | null | Promise<AuthenticatedUser | null>;

export type AuthStrategy = {
  name: string;
  canHandle?: (
    req: Request,
    route: AnyRouteDefinition,
  ) => boolean | Promise<boolean>;
  authenticate: AuthResolver;
};

export function defaultHeaderAuthResolver(
  req: Request,
): AuthenticatedUser | null {
  const userIdHeader = req.headers["x-user-id"];
  const userMetaHeader = req.headers["x-user-meta"];

  if (typeof userMetaHeader === "string") {
    try {
      const parsed = JSON.parse(userMetaHeader) as Partial<AuthenticatedUser>;

      if (typeof parsed.userId === "string") {
        return parsed as AuthenticatedUser;
      }
    } catch {
      return null;
    }
  }

  if (typeof userIdHeader !== "string") {
    return null;
  }

  return {
    userId: userIdHeader,
  };
}

export function createAuthResolver(
  strategies: AuthStrategy[],
  opts: { fallbackResolver?: AuthResolver } = {},
): AuthResolver {
  return async (req, route) => {
    for (const strategy of strategies) {
      if (strategy.canHandle) {
        const canHandle = await strategy.canHandle(req, route);
        if (!canHandle) {
          continue;
        }
      }

      const user = await strategy.authenticate(req, route);
      if (user) {
        return user;
      }
    }

    if (opts.fallbackResolver) {
      return opts.fallbackResolver(req, route);
    }

    return null;
  };
}

type Infer<T, TFallback> = T extends ZodType ? output<T> : TFallback;

export type TypedRequest<
  TBody = unknown,
  TParams = unknown,
  TRequireAuth extends boolean = false,
  TQuery = unknown,
> = Request<
  Infer<TParams, Record<string, string>>,
  any,
  Infer<TBody, any>,
  Infer<TQuery, Request["query"]>
> &
  (TRequireAuth extends true
    ? { user: AuthenticatedUser }
    : { user?: AuthenticatedUser });

export type TypedRequestHandler<
  TBody = unknown,
  TParams = unknown,
  TRequireAuth extends boolean = false,
  TQuery = unknown,
> = (
  req: TypedRequest<TBody, TParams, TRequireAuth, TQuery>,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Defines a route with enhanced type safety and built-in support for request validation and authentication. This type is used in conjunction with the `addRoute` function to register routes on an Express router, allowing you to specify the HTTP method, path, authentication requirements, and Zod schemas for validating the request body, URL parameters and query string. The route definition also includes optional metadata used for documentation (OpenAPI), rate limiting and deprecation headers.
 */
export type RouteDefinition<
  TBody extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
  TRequireAuth extends boolean = false,
  TQuery extends ZodType | undefined = undefined,
> = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  fullPath: string;
  requireAuth?: TRequireAuth;
  /**
   * Optional Zod schema to validate the request body. Only applicable for non-GET requests. Invalid bodies get a 400 response.
   */
  bodyValidator?: TBody;
  /**
   * Optional Zod schema to validate URL parameters (e.g., :id in /users/:id). Invalid parameters get a 400 response.
   */
  paramsValidator?: TParams;
  /**
   * Optional Zod schema to validate the query string. Query values arrive as strings (or arrays of strings), so use `z.coerce` for numbers and booleans. Invalid queries get a 400 response.
   */
  queryValidator?: TQuery;
  /**
   * Optional metadata for the route, used for documentation, rate limiting and deprecation headers.
   */
  meta?: RouteMeta;
};

/**
 * A route definition with any validators, for collections of routes.
 */
export type AnyRouteDefinition = RouteDefinition<any, any, boolean, any>;

type CreateMetaRouterOptions = {
  authResolver?: AuthResolver;
  onUnauthorized?: (req: Request, res: Response) => void;
  onAuthError?: (err: unknown, req: Request, res: Response) => void;
};

type AddRoute = <
  TBody extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
  TRequireAuth extends boolean = false,
  TQuery extends ZodType | undefined = undefined,
>(
  route: RouteDefinition<TBody, TParams, TRequireAuth, TQuery>,
  /** Request handler for the route */ handler: TypedRequestHandler<
    TBody,
    TParams,
    TRequireAuth,
    TQuery
  >,
) => void;

/**
 * Validates one part of the request and replaces it with the parsed value.
 */
function validate(
  schema: ZodType,
  read: (req: Request) => unknown,
  write: (req: Request, value: unknown) => void,
  message: string,
): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(read(req));
    if (!result.success) {
      res
        .status(400)
        .json(errorBody(req, message, { details: result.error.issues }));
      return;
    }
    write(req, result.data);
    next();
  };
}

/**
 * Validates the body. Bodies sent without a JSON content type arrive as
 * strings, so they are parsed first when the schema expects structured data
 * or a number.
 */
function validateBody(schema: ZodType): RequestHandler {
  const type = (schema as { def?: { type?: string } }).def?.type;
  const validateParsed = validate(
    schema,
    (req) => req.body,
    (req, value) => {
      req.body = value;
    },
    "Invalid request body",
  );

  return (req, res, next) => {
    if (typeof req.body === "string") {
      if (type === "object" || type === "array") {
        try {
          req.body = JSON.parse(req.body);
        } catch {
          res.status(400).json(errorBody(req, "Invalid JSON in request body"));
          return;
        }
      } else if (type === "number") {
        const value = Number(req.body);
        if (Number.isNaN(value)) {
          res
            .status(400)
            .json(errorBody(req, "Invalid number in request body"));
          return;
        }
        req.body = value;
      }
    }
    validateParsed(req, res, next);
  };
}

/**
 * Creates an Express router whose routes carry metadata, Zod validation for the body, URL parameters and query string, and optional authentication.
 *
 * Route handlers may be async; thrown errors (including `HttpError`) are sent through the service's error middleware.
 */
export function createMetaRouter(options?: CreateMetaRouterOptions): {
  /**
   * The Express router to pass to `service.addRouter()`.
   */
  router: Router;
  /**
   * Every route added so far, for introspection, OpenAPI generation and the service registry.
   */
  routes: AnyRouteDefinition[];
  /**
   * Adds a route with the given definition and handler.
   *
   * - `requireAuth: true` resolves the user first and returns 401 when there is none; `req.user` is then typed as present.
   * - `bodyValidator`, `paramsValidator` and `queryValidator` validate and replace `req.body`, `req.params` and `req.query`, returning 400 with `details` when validation fails.
   *
   * @example
   * addRoute(
   *   {
   *     fullPath: "/users/:id",
   *     method: "GET",
   *     requireAuth: true,
   *     paramsValidator: z.object({ id: z.string() }),
   *     meta: { description: "Get a user" },
   *   },
   *   async (req, res) => {
   *     const user = await service.db.users.getOne({ id: req.params.id });
   *     if (!user) throw new HttpError(404, "User not found");
   *     res.json(user);
   *   },
   * );
   */
  addRoute: AddRoute;
} {
  const router = Router();
  const routes: AnyRouteDefinition[] = [];
  const authResolver: AuthResolver =
    options?.authResolver ?? ((req) => defaultHeaderAuthResolver(req));
  const onUnauthorized =
    options?.onUnauthorized ??
    ((req: Request, res: Response) => {
      res.status(401).json(errorBody(req, "Unauthorized"));
    });
  const onAuthError =
    options?.onAuthError ??
    ((_: unknown, req: Request, res: Response) => {
      res.status(401).json(errorBody(req, "Unauthorized"));
    });

  const addRoute: AddRoute = (route, handler) => {
    const middlewareStack: RequestHandler[] = [];
    const { bodyValidator, paramsValidator, queryValidator } = route;

    routes.push({
      method: route.method,
      fullPath: route.fullPath,
      requireAuth: route.requireAuth ?? false,
      meta: route.meta,
      bodyValidator,
      paramsValidator,
      queryValidator,
    });

    const deprecated = route.meta?.deprecated;
    if (deprecated) {
      const value =
        deprecated instanceof Date
          ? `@${Math.floor(deprecated.getTime() / 1000)}`
          : "true";
      middlewareStack.push((_req, res, next) => {
        res.setHeader("Deprecation", value);
        next();
      });
    }

    if (route.requireAuth) {
      middlewareStack.push(async (req, res, next) => {
        try {
          const user = await authResolver(req, route);

          if (!user) {
            onUnauthorized(req, res);
            return;
          }

          (req as TypedRequest<unknown, unknown, true>).user = user;
          next();
        } catch (err) {
          onAuthError(err, req, res);
        }
      });
    }
    // After auth, so limits can be keyed by the authenticated user.
    if (route.meta?.rateLimit !== "none") {
      middlewareStack.push(rateLimitMiddleware(route));
    }
    if (paramsValidator) {
      middlewareStack.push(
        validate(
          paramsValidator,
          (req) => req.params,
          (req, value) => {
            req.params = value as Request["params"];
          },
          "Invalid URL parameters",
        ),
      );
    }
    if (queryValidator) {
      middlewareStack.push(
        validate(
          queryValidator,
          (req) => req.query,
          // Express 5 defines req.query as a getter without a setter.
          (req, value) => {
            Object.defineProperty(req, "query", {
              value,
              writable: true,
              configurable: true,
              enumerable: true,
            });
          },
          "Invalid query parameters",
        ),
      );
    }
    if (bodyValidator && route.method !== "GET") {
      middlewareStack.push(validateBody(bodyValidator));
    }
    (router as any)[route.method.toLowerCase()](
      route.fullPath,
      ...middlewareStack,
      handler as RequestHandler,
    );
  };

  return {
    router,
    routes,
    addRoute,
  };
}
