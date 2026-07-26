import express, { Express, Router } from "express";
import cors from "cors";
import {
  AuthResolver,
  createMetaRouter,
  RouteDefinition,
} from "../../api/express-types";
import { ExpressOptions, CustomModules } from "../types";
import { getUseableDatesFromMs } from "../utils";

type Log = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type RouteRecord = {
  base: string;
  router: Router;
  routes?: RouteDefinition<any, any, boolean>[];
};

type ServiceApiBaseContext = {
  log: Log;
  name: string;
  getStatus: () => "starting" | "running" | "stopped" | "stopping";
  startedAt: number;
  dependencies: Map<string, unknown>;
  getRoutes: () => {
    path: string;
    method: RouteDefinition<any, any, boolean>["method"];
    requireAuth: boolean;
    meta: RouteDefinition<any, any, boolean>["meta"];
  }[];
  getLoadedEventListeners: () => string[];
  handlers: Record<string, string>;
  getIsWorkerRunning: () => boolean;
  streamKey: string;
  simpleName: string;
  getRedis: () => {
    xRange: (...args: any[]) => Promise<any>;
    xAck: (...args: any[]) => Promise<any>;
    xAdd: (...args: any[]) => Promise<any>;
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
  fullUrl: string;
  port: number;
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

  if ("corsWhitelist" in ctx.expressOptions) {
    ctx.log.info(
      "Configuring CORS with whitelist: " + ctx.expressOptions.corsWhitelist,
    );
    ctx.api.use(
      cors({
        origin: ctx.expressOptions.corsWhitelist,
        credentials: ctx.expressOptions.credentials,
      }),
    );
  } else if ("corsFn" in ctx.expressOptions) {
    ctx.log.info("Configuring CORS with function");
    ctx.api.use(
      cors({
        origin: ctx.expressOptions.corsFn,
        credentials: ctx.expressOptions.credentials,
      }),
    );
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

  ctx.api.listen(ctx.port, () => {
    ctx.log.info(`API listening at ${ctx.fullUrl}`);
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

function initWorkerRoutes(ctx: ServiceApiBaseContext): void {
  const { router, routes, addRoute } = createMetaRouter({
    authResolver: ctx.getAuthResolver(),
  });

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
        handlersLoaded: Object.keys(ctx.handlers),
      });
    },
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/:stream",
      requireAuth: true,
      meta: {
        description: "Get stream messages",
      },
    },
    async (_, res) => {
      const redis = ctx.getRedis();
      if (!redis) {
        return res.status(500).json({ error: "Redis client not connected" });
      }
      const messages = await redis.xRange(ctx.streamKey, "-", "+", {
        COUNT: 10,
      });
      res.json({ status: "Stream", messages });
    },
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
    async (req, res) => {
      const { stream, id } = req.params;
      const redis = ctx.getRedis();
      if (!redis) {
        return res.status(500).json({ error: "Redis client not connected" });
      }
      const result = await redis.xAck(
        stream,
        `${ctx.simpleName}:consumer-group`,
        id,
      );
      res.json({ status: "Message acknowledged", result });
    },
  );

  addRoute(
    {
      method: "GET",
      fullPath: "/:stream/dlq",
      requireAuth: true,
      meta: {
        description: "Get DLQ stream messages",
      },
    },
    async (_, res) => {
      const redis = ctx.getRedis();
      if (!redis) {
        return res.status(500).json({ error: "Redis client not connected" });
      }
      const messages = await redis.xRange(ctx.streamKey, "-", "+", {
        COUNT: 10,
      });
      res.json({ status: "DLQ Stream", messages });
    },
  );

  addRoute(
    {
      method: "POST",
      fullPath: "/:stream/dlq/:id/retry",
      requireAuth: true,
      meta: {
        description: "Retry a message in the DLQ",
      },
    },
    async (req, res) => {
      const { stream, id } = req.params;
      const redis = ctx.getRedis();
      if (!redis) {
        return res.status(500).json({ error: "Redis client not connected" });
      }
      const dlqMessage = await redis.xRange(stream, id, id);
      if (dlqMessage.length === 0 || dlqMessage[0].id !== id) {
        return res.status(404).json({ error: "Message not found in DLQ" });
      }
      const result = await redis.xAdd(
        stream,
        `${ctx.simpleName}:consumer-group`,
        dlqMessage[0].message,
      );
      res.json({ status: "Message retried", result });
    },
  );

  ctx.internalAddRouter("/workers", router, routes);
}
