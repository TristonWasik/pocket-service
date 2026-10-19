import { createServer, Server } from "http";
import express, { Express, Request, Response, Router } from "express";
import cors, { CorsOptions } from "cors";
import type { Logger } from "winston";
import {
  createErrorHandler,
  HttpError,
  notFoundHandler,
} from "../../api/errors";
import { requestContext } from "../../api/request-context";
import { buildOpenApiDocument, OpenApiOptions } from "../../api/openapi";
import { RATE_LIMITER_KEY, RateLimiter } from "../../api/rate-limit";
import {
  AuthResolver,
  createMetaRouter,
  AnyRouteDefinition,
} from "../../api/express-types";
import { dlqStream, groupName } from "../../runtime/stream-names";
import { ExpressOptions, CustomModules, Log, ServiceStatus } from "../types";
import { getUseableDatesFromMs } from "../utils";
import type { WorkerState } from "./workers";
import { INTERNAL_DEPENDENCIES } from "./config";

const READINESS_TIMEOUT_MS = 2_000;

export type ReadinessCheck = () => Promise<unknown>;

type RouteRecord = {
  base: string;
  router: Router;
  routes?: AnyRouteDefinition[];
};

type ServiceApiBaseContext = {
  log: Log;
  name: string;
  getStatus: () => ServiceStatus;
  startedAt: number;
  dependencies: Map<string, unknown>;
  getRoutes: () => {
    path: string;
    method: AnyRouteDefinition["method"];
    requireAuth: boolean;
    meta: AnyRouteDefinition["meta"];
  }[];
  getLoadedEventListeners: () => string[];
  getIsWorkerRunning: () => boolean;
  getWorkerStatus: () => WorkerState[];
  workerSubscriptions: string[];
  getRedis: () => {
    xRange: (...args: any[]) => Promise<any>;
    xRevRange: (...args: any[]) => Promise<any>;
    xAck: (...args: any[]) => Promise<any>;
    xAdd: (...args: any[]) => Promise<any>;
    xDel: (...args: any[]) => Promise<any>;
    xPending: (...args: any[]) => Promise<any>;
  };
  getAuthResolver: () => AuthResolver;
  getReadinessChecks: () => Record<string, ReadinessCheck>;
  internalAddRouter: (
    base: string,
    router: Router,
    routes?: AnyRouteDefinition[],
  ) => void;
};

export type ServiceApiRuntimeContext = ServiceApiBaseContext & {
  logger: Logger;
  withoutExpressFlag: boolean;
  expressOptions: ExpressOptions;
  api: Express;
  routers: RouteRecord[];
  openApi?: OpenApiOptions;
  rateLimiter?: RateLimiter;
};

export function registerDefaultRoutes(ctx: ServiceApiBaseContext) {
  initBaseRoutes(ctx);
  if (ctx.dependencies.has("redis") && ctx.dependencies.has("workers")) {
    ctx.log.info(
      "Redis and handler modules detected. Registering worker routes.",
    );
    initWorkerRoutes(ctx);
  }

  ctx.log.info("Default routes registered.");
}

export function setupExpressApp(ctx: ServiceApiRuntimeContext) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn("Express server is disabled. Service built without Express.");
    return;
  }

  if (ctx.expressOptions.trustProxy !== undefined) {
    ctx.api.set("trust proxy", ctx.expressOptions.trustProxy);
  }
  if (ctx.rateLimiter) {
    ctx.api.locals[RATE_LIMITER_KEY] = ctx.rateLimiter;
  }

  // First, so every later middleware and error response has a request ID.
  ctx.api.use(requestContext(ctx.logger));

  if (ctx.expressOptions.asJson) {
    ctx.log.info("Configuring Express to parse JSON bodies");
    ctx.api.use(express.json());
  }

  for (const mw of ctx.expressOptions.customMiddleware || []) {
    ctx.log.info("Adding custom middleware to Express");
    ctx.api.use(mw);
  }

  const corsOptions = resolveCorsOptions(ctx.expressOptions);
  if (corsOptions) {
    ctx.log.info(
      "corsFn" in ctx.expressOptions
        ? "Configuring CORS with function"
        : `Configuring CORS with whitelist: ${ctx.expressOptions.corsWhitelist}`,
    );
    ctx.api.use(cors(corsOptions));
  }

  if (!ctx.expressOptions.omitDefaultRoutes) {
    registerDefaultRoutes(ctx);
  }

  if (ctx.openApi) {
    registerOpenApiRoute(ctx, ctx.openApi);
  }

  ctx.log.info(`Registering ${ctx.routers.length} routers`);
  ctx.routers.forEach(({ base, router }) => {
    ctx.api.use(base, router);
  });

  ctx.log.info(
    "Routers registered:" +
      ctx.routers
        .map((rt) => {
          const maxMethodLength = rt.routes
            ? Math.max(...rt.routes.map((r) => r.method.length))
            : 0;
          const maxPathLength = rt.routes
            ? Math.max(...rt.routes.map((r) => r.fullPath.length))
            : 0;
          const maxAuthLength = rt.routes
            ? Math.max(...rt.routes.map((r) => (r.requireAuth ? 6 : 8)))
            : 0;

          return `\nRouter ${rt.base}: ${
            rt.routes?.length || 0
          } routes registered.\n${
            rt.routes
              ?.map(
                (r) =>
                  `\t${("[" + r.method + "]").padEnd(maxMethodLength + 2)} ${(r.requireAuth ? "[Auth]" : "[Public]").padEnd(maxAuthLength)} ${r.fullPath.padEnd(maxPathLength)} | ${r.meta?.description || ""}`,
              )
              .join("\n") || ""
          }`;
        })
        .join("\n"),
  );

  ctx.api.use(notFoundHandler);
  ctx.api.use(createErrorHandler(ctx.log));
}

/**
 * Serves the OpenAPI document. It is built on the first request, once every
 * router has been registered, and then cached.
 */
function registerOpenApiRoute(
  ctx: ServiceApiRuntimeContext,
  options: OpenApiOptions,
) {
  const path = options.path ?? "/openapi.json";
  const { router, routes, addRoute } = createMetaRouter();
  let document: ReturnType<typeof buildOpenApiDocument> | null = null;

  addRoute(
    {
      method: "GET",
      fullPath: path,
      requireAuth: false,
      meta: { description: "OpenAPI document for this service" },
    },
    (_, res) => {
      document ??= buildOpenApiDocument(ctx.routers, {
        ...options,
        defaultTitle: ctx.name,
      });
      res.json(document);
    },
  );

  ctx.internalAddRouter("/", router, routes);
}

/**
 * Maps ExpressOptions to `cors` options. A whitelist containing `"*"` allows
 * any origin, which browsers reject in combination with credentials.
 */
export function resolveCorsOptions(
  options: ExpressOptions,
): CorsOptions | null {
  if ("corsFn" in options && options.corsFn) {
    return { origin: options.corsFn, credentials: options.credentials };
  }
  if (!("corsWhitelist" in options) || !options.corsWhitelist) {
    return null;
  }
  if (options.corsWhitelist.includes("*")) {
    if (options.credentials) {
      throw new Error(
        'CORS: corsWhitelist "*" cannot be combined with credentials: true. List explicit origins instead.',
      );
    }
    return { origin: "*" };
  }
  return { origin: options.corsWhitelist, credentials: options.credentials };
}

/**
 * Starts listening and resolves once the port is bound. Rejects on listen
 * errors such as EADDRINUSE.
 */
export function startHttpServer(ctx: {
  api: Express;
  port: number;
  fullUrl: string;
  log: Log;
}): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(ctx.api);
    server.once("error", reject);
    server.listen(ctx.port, () => {
      server.off("error", reject);
      ctx.log.info(`API listening at ${ctx.fullUrl}`);
      resolve(server);
    });
  });
}

/**
 * Stops accepting connections, closes idle keep-alive sockets, and resolves
 * once in-flight requests have finished.
 */
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}

function initBaseRoutes(ctx: ServiceApiBaseContext) {
  ctx.log.info("Registering base routes");
  const { router, routes, addRoute } = createMetaRouter({
    authResolver: ctx.getAuthResolver(),
  });

  addRoute(
    {
      method: "GET",
      fullPath: "/",
      requireAuth: false,
      meta: {
        description: "Base route",
      },
    },
    (_, res) => {
      res.send('OK from "' + ctx.name + '" service');
    },
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/health",
      requireAuth: false,
      meta: {
        description:
          "Health check route that returns service status and uptime",
      },
    },
    (_, res) => {
      res.status(200).json({
        service: ctx.name,
        status: ctx.getStatus(),
        startedAt: new Date(ctx.startedAt),
        uptime: getUseableDatesFromMs(Math.floor(process.uptime() * 1000)),
        workerRunning: ctx.getIsWorkerRunning(),
        modulesLoaded: Array.from(ctx.dependencies.keys())
          .filter((key) => !INTERNAL_DEPENDENCIES.has(key))
          .concat(
            Array.from(
              ctx.dependencies.has("customDependencies")
                ? (
                    ctx.dependencies.get("customDependencies") as CustomModules
                  ).map((d) => `custom:${d.name}`)
                : [],
            ),
          ),
        routesLoaded: ctx.getRoutes(),
        handlersLoaded: ctx.getLoadedEventListeners(),
      });
    },
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/health/live",
      requireAuth: false,
      meta: { description: "Liveness probe: 200 while the process is up" },
    },
    (_, res) => {
      res.json({ status: "ok" });
    },
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/health/ready",
      requireAuth: false,
      meta: {
        description:
          "Readiness probe: 200 when the service is running and every dependency responds, otherwise 503",
      },
    },
    async (_, res) => {
      const status = ctx.getStatus();
      if (status !== "running") {
        res.status(503).json({
          status: "not_ready",
          reason: `Service is ${status}`,
          checks: {},
        });
        return;
      }

      const entries = Object.entries(ctx.getReadinessChecks());
      const results = await Promise.all(
        entries.map(([, check]) => runReadinessCheck(check)),
      );
      const checks = Object.fromEntries(
        entries.map(([name], i) => [name, results[i]]),
      );
      const ready = results.every((result) => result === "ok");

      res
        .status(ready ? 200 : 503)
        .json({ status: ready ? "ready" : "not_ready", checks });
    },
  );

  ctx.internalAddRouter("/", router, routes);
}

/**
 * Runs one readiness check with a timeout, returning "ok" or the error
 * message.
 */
async function runReadinessCheck(check: ReadinessCheck): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Timed out after ${READINESS_TIMEOUT_MS}ms`)),
          READINESS_TIMEOUT_MS,
        );
      }),
    ]);
    return "ok";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
}

const MAX_STREAM_PAGE = 100;

function parseCount(value: unknown) {
  const count = Number(value ?? 10);
  return Number.isInteger(count) && count > 0
    ? Math.min(count, MAX_STREAM_PAGE)
    : 10;
}

function initWorkerRoutes(ctx: ServiceApiBaseContext): void {
  const { router, routes, addRoute } = createMetaRouter({
    authResolver: ctx.getAuthResolver(),
  });
  const group = groupName(ctx.name);

  /**
   * Only streams this service subscribes to are exposed, so the routes cannot
   * be used to read or modify arbitrary Redis keys.
   */
  function withStream(
    handler: (stream: string, req: Request, res: Response) => Promise<unknown>,
  ) {
    return async (req: Request, res: Response) => {
      const stream = String(req.params.stream);
      if (!ctx.workerSubscriptions.includes(stream)) {
        throw new HttpError(404, `Unknown stream: ${stream}`);
      }
      await handler(stream, req, res);
    };
  }

  addRoute(
    {
      method: "GET",
      fullPath: "/",
      requireAuth: true,
      meta: {
        description: "Get worker status",
      },
    },
    (_, res) => {
      res.json({
        status: ctx.getIsWorkerRunning() ? "Running" : "Stopped",
        workers: ctx.getWorkerStatus(),
        subscriptions: ctx.workerSubscriptions,
        handlersLoaded: ctx.getLoadedEventListeners(),
      });
    },
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/:stream",
      requireAuth: true,
      meta: {
        description: "Get the most recent stream messages (?count, max 100)",
      },
    },
    withStream(async (stream, req, res) => {
      const messages = await ctx
        .getRedis()
        .xRevRange(stream, "+", "-", { COUNT: parseCount(req.query.count) });
      res.json({ stream, messages });
    }),
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/:stream/pending",
      requireAuth: true,
      meta: {
        description: "Get the pending-entries summary for this service's group",
      },
    },
    withStream(async (stream, _, res) => {
      const pending = await ctx.getRedis().xPending(stream, group);
      res.json({ stream, group, pending });
    }),
  );

  addRoute(
    {
      method: "POST",
      fullPath: "/:stream/:id/ack",
      requireAuth: true,
      meta: {
        description: "Acknowledge a message in the stream",
      },
    },
    withStream(async (stream, req, res) => {
      const result = await ctx
        .getRedis()
        .xAck(stream, group, String(req.params.id));
      res.json({ status: "Message acknowledged", result });
    }),
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/:stream/dlq",
      requireAuth: true,
      meta: {
        description: "Get the most recent DLQ messages (?count, max 100)",
      },
    },
    withStream(async (stream, req, res) => {
      const messages = await ctx
        .getRedis()
        .xRevRange(dlqStream(stream), "+", "-", {
          COUNT: parseCount(req.query.count),
        });
      res.json({ stream: dlqStream(stream), messages });
    }),
  );

  addRoute(
    {
      method: "POST",
      fullPath: "/:stream/dlq/:id/retry",
      requireAuth: true,
      meta: {
        description: "Re-publish a DLQ message to its stream and remove it from the DLQ",
      },
    },
    withStream(async (stream, req, res) => {
      const id = String(req.params.id);
      const redis = ctx.getRedis();
      const [entry] = await redis.xRange(dlqStream(stream), id, id);
      if (!entry) {
        throw new HttpError(404, "Message not found in DLQ");
      }
      const fields = JSON.parse(entry.message.message) as Record<
        string,
        string
      >;
      const newId = await redis.xAdd(stream, "*", fields);
      await redis.xDel(dlqStream(stream), id);
      res.json({ status: "Message retried", id: newId });
    }),
  );

  ctx.internalAddRouter("/workers", router, routes);
}
