import { createServer, Server } from "http";
import express, { Express, Request, Response, Router } from "express";
import cors, { CorsOptions } from "cors";
import {
  AuthResolver,
  createMetaRouter,
  RouteDefinition,
} from "../../api/express-types";
import { dlqStream, groupName } from "../../runtime/stream-names";
import { ExpressOptions, CustomModules, Log, ServiceStatus } from "../types";
import { getUseableDatesFromMs } from "../utils";
import type { WorkerState } from "./workers";

type RouteRecord = {
  base: string;
  router: Router;
  routes?: RouteDefinition<any, any, boolean>[];
};

type ServiceApiBaseContext = {
  log: Log;
  name: string;
  getStatus: () => ServiceStatus;
  startedAt: number;
  dependencies: Map<string, unknown>;
  getRoutes: () => {
    path: string;
    method: RouteDefinition<any, any, boolean>["method"];
    requireAuth: boolean;
    meta: RouteDefinition<any, any, boolean>["meta"];
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
  internalAddRouter: (
    base: string,
    router: Router,
    routes?: RouteDefinition<any, any, boolean>[],
  ) => void;
};

export type ServiceApiRuntimeContext = ServiceApiBaseContext & {
  withoutExpressFlag: boolean;
  expressOptions: ExpressOptions;
  api: Express;
  routers: RouteRecord[];
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
          .filter((f) => f !== "customDependencies")
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

  ctx.internalAddRouter("/", router, routes);
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
        res.status(404).json({ error: `Unknown stream: ${stream}` });
        return;
      }
      try {
        await handler(stream, req, res);
      } catch (err) {
        ctx.log.error(`Worker route failed for ${stream}: ${err}`);
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
        return res.status(404).json({ error: "Message not found in DLQ" });
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
