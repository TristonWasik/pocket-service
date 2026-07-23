import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import z, { ZodSchema, output } from "zod";

export type RouteMeta = {
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  authRequired?: boolean;
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
  route: RouteDefinition<any, any, boolean>,
) => AuthenticatedUser | null | Promise<AuthenticatedUser | null>;

export type AuthStrategy = {
  name: string;
  canHandle?: (
    req: Request,
    route: RouteDefinition<any, any, boolean>,
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

export type TypedRequest<
  TBody = unknown,
  TParams = unknown,
  TRequireAuth extends boolean = false,
> = Request<
  TParams extends ZodSchema ? output<TParams> : Record<string, string>,
  any,
  TBody extends ZodSchema ? output<TBody> : any
> &
  (TRequireAuth extends true
    ? { user: AuthenticatedUser }
    : { user?: AuthenticatedUser });

export type TypedRequestHandler<
  TBody = unknown,
  TParams = unknown,
  TRequireAuth extends boolean = false,
> = (
  req: TypedRequest<TBody, TParams, TRequireAuth>,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Defines a route with enhanced type safety and built-in support for request validation and authentication. This type is used in conjunction with the `addRoute` function to register routes on an Express router, allowing you to specify the HTTP method, path, authentication requirements, and Zod schemas for validating request bodies and URL parameters. The route definition also includes optional metadata that can be used for documentation or analytics purposes.
 */
export type RouteDefinition<
  TBody extends ZodSchema | undefined = undefined,
  TParams extends ZodSchema | undefined = undefined,
  TRequireAuth extends boolean = false,
> = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  fullPath: string;
  requireAuth?: TRequireAuth;
  /**
   * Optional Zod schema to validate the request body. Only applicable for non-GET requests. If provided, the middleware will automatically validate the request body against this schema and return a 400 error if validation fails.
   */
  bodyValidator?: TBody;
  /**
   * Optional Zod schema to validate URL parameters (e.g., :id in /users/:id). If provided, the middleware will automatically validate the URL parameters against this schema and return a 400 error if validation fails.
   */
  paramsValidator?: TParams;
  /**
   * Optional metadata for the route, which can be used for documentation, analytics, or other purposes.
   */
  meta?: RouteMeta;
};

const registeredRoutes: RouteDefinition<any, any, boolean>[] = [];

export function getRegisteredRoutes() {
  return registeredRoutes;
}

type CreateMetaRouterOptions = {
  authResolver?: AuthResolver;
  onUnauthorized?: (req: Request, res: Response) => void;
  onAuthError?: (err: unknown, req: Request, res: Response) => void;
};

/**
 * Utility function to create an Express router with enhanced type safety and built-in support for request validation and authentication. This function allows you to define routes with associated Zod schemas for validating request bodies and URL parameters, as well as specifying whether authentication is required for each route. The returned object includes the configured Express router, a list of registered routes for introspection, and a helper function to add new routes with the specified configurations.
 */
export function createMetaRouter(options?: CreateMetaRouterOptions): {
  /**
   * The Express router instance that can be used to register routes and middleware. This router is configured to work with the enhanced route definitions provided by the `addRoute` function, which supports request validation and authentication requirements.
   */
  router: Router;
  /**
   * List of registered routes with their configurations, which can be used for introspection, documentation generation, or analytics purposes. Each entry includes the HTTP method, full path, authentication requirement, validation schemas, and any additional metadata provided during route registration.
   */
  routes: RouteDefinition<any, any, boolean>[];
  /**
   * Adds a new route to the router with the specified configuration and request handler.
   *
   * - If `requireAuth` is set to true, the route will automatically include middleware to check for an authenticated user and return a 401 error if the user is not authenticated.
   * - If `bodyValidator` or `paramsValidator` are provided, the route will include middleware to validate the request body and URL parameters against the provided Zod schemas, returning a 400 error if validation fails.
   *
   * The route definition is also stored in an internal list for introspection purposes.
   *
   * @param route The route definition, including method, path, validation schemas, and authentication requirements.
   * @param handler The request handler function for the route.
   * @returns void
   *
   * @example
   * addRoute(
   *   {
   *     fullPath: "/me",
   *     method: "GET",
   *     requireAuth: true,
   *     meta: {
   *       description: "Get current authenticated user info",
   *     },
   *   },
   *   async (req, res) => {
   *     try {
   *       ...fetch user info from database using req.user.userId...
   *       res.status(200).json(...user info...);
   *     } catch (err) {
   *       console.error("Failed to fetch user info:", err);
   *       res
   *         .status(500)
   *         .json({ isSuccess: false, message: "Internal server error" });
   *     }
   *   },
   * );
   */
  addRoute: <
    TBody extends ZodSchema | undefined = undefined,
    TParams extends ZodSchema | undefined = undefined,
    TRequireAuth extends boolean = false,
  >(
    route: RouteDefinition<TBody, TParams, TRequireAuth>,
    /** Request handler for the route */ handler: TypedRequestHandler<
      TBody,
      TParams,
      TRequireAuth
    >,
  ) => void;
} {
  const router = Router();
  const routes: RouteDefinition<any, any, boolean>[] = [];
  const authResolver: AuthResolver =
    options?.authResolver ?? ((req) => defaultHeaderAuthResolver(req));
  const onUnauthorized =
    options?.onUnauthorized ??
    ((_: Request, res: Response) => {
      res.status(401).json({
        isSuccess: false,
        message: "Unauthorized",
      });
    });
  const onAuthError =
    options?.onAuthError ??
    ((_: unknown, __: Request, res: Response) => {
      res.status(401).json({
        isSuccess: false,
        message: "Unauthorized",
      });
    });

  /**
   * Adds a new route to the router with the specified configuration and request handler.
   *
   * - If `requireAuth` is set to true, the route will automatically include middleware to check for an authenticated user and return a 401 error if the user is not authenticated.
   * - If `bodyValidator` or `paramsValidator` are provided, the route will include middleware to validate the request body and URL parameters against the provided Zod schemas, returning a 400 error if validation fails.
   *
   * The route definition is also stored in an internal list for introspection purposes.
   * @param route The route definition, including method, path, validation schemas, and authentication requirements.
   * @param handler The request handler function for the route.
   *
   * @example
   * addRoute(
   *   {
   *     fullPath: "/me",
   *     method: "GET",
   *     requireAuth: true,
   *     meta: {
   *       description: "Get current authenticated user info",
   *     },
   *   },
   *   async (req, res) => {
   *     try {
   *       ...fetch user info from database using req.user.userId...
   *       res.status(200).json(...user info...);
   *     } catch (err) {
   *       console.error("Failed to fetch user info:", err);
   *       res
   *         .status(500)
   *         .json({ isSuccess: false, message: "Internal server error" });
   *     }
   *   },
   * );
   */
  function addRoute<
    TBody extends ZodSchema | undefined = undefined,
    TParams extends ZodSchema | undefined = undefined,
    TRequireAuth extends boolean = false,
  >(
    route: RouteDefinition<TBody, TParams, TRequireAuth>,
    /** Request handler for the route */ handler: TypedRequestHandler<
      TBody,
      TParams,
      TRequireAuth
    >,
  ) {
    const middlewareStack: RequestHandler[] = [];
    const bodyValidator = route.bodyValidator;
    const paramsValidator = route.paramsValidator;

    routes.push({
      method: route.method,
      fullPath: route.fullPath,
      requireAuth: route.requireAuth ?? false,
      meta: route.meta,
      bodyValidator,
      paramsValidator,
    });
    if (route.requireAuth) {
      middlewareStack.push(async (req, res, next) => {
        try {
          const user = await authResolver(req, route);

          if (!user) {
            onUnauthorized(req, res);
            return;
          }

          (req as TypedRequest<TBody, TParams, true>).user = user;
          next();
        } catch (err) {
          onAuthError(err, req, res);
        }
      });
    }
    if (bodyValidator && route.method !== "GET") {
      middlewareStack.push((req, res, next) => {
        let value = req.body;
        if (typeof value === "string") {
          if (
            bodyValidator instanceof z.ZodObject ||
            bodyValidator instanceof z.ZodArray ||
            bodyValidator.def.type === "object" ||
            bodyValidator.def.type === "array"
          ) {
            try {
              value = JSON.parse(value);
            } catch (e) {
              return res.status(400).json({
                isSuccess: false,
                message: "Invalid JSON in request body",
                error: e instanceof Error ? e.message : e,
              });
            }
          } else if (
            bodyValidator instanceof z.ZodNumber ||
            bodyValidator.def.type === "number"
          ) {
            try {
              value = Number(value);
            } catch (e) {
              return res.status(400).json({
                isSuccess: false,
                message: "Invalid number in request body",
                error: e instanceof Error ? e.message : e,
              });
            }
          }
        }
        const validationResult = bodyValidator.safeParse(value);
        if (validationResult.success) {
          req.body = validationResult.data;
          next();
        } else {
          res.status(400).json({
            isSuccess: false,
            message: "Invalid request body",
            error: validationResult.error,
          });
        }
      });
    }
    if (paramsValidator) {
      middlewareStack.push((req, res, next) => {
        const validationResult = paramsValidator.safeParse(req.params);
        if (validationResult.success) {
          req.params = validationResult.data as Request["params"];
          next();
        } else {
          res.status(400).json({
            isSuccess: false,
            message: "Invalid URL parameters",
            error: validationResult.error,
          });
        }
      });
    }
    (router as any)[route.method.toLowerCase()](
      route.fullPath,
      ...middlewareStack,
      handler as RequestHandler,
    );
  }

  return {
    router,
    routes,
    addRoute,
  };
}
