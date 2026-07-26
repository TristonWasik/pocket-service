import { CustomModules } from "../types";

type Log = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type ServiceLifecycleContext = {
  dependencyOrder: string[];
  dependencies: Map<string, unknown>;
  log: Log;
  loadHandlers: () => void;
  runWorkers: () => void;
  connectRedis: () => Promise<unknown>;
  register: () => Promise<void>;
  heartbeat: () => Promise<void>;
  shutdown: () => Promise<void>;
  connectMongo: () => Promise<unknown>;
  ensureClickhouseTables: () => Promise<void>;
};

export function initializeDependencies(ctx: ServiceLifecycleContext) {
  Promise.allSettled(
    ctx.dependencyOrder
      .filter((f) => f !== "customDependencies")
      .map((key) => {
        switch (key) {
          case "redis": {
            if (ctx.dependencies.has("workers")) {
              ctx.loadHandlers();
              ctx.runWorkers();
            } else {
              ctx.log.warn(
                "Worker module not initialized. Call withWorkers() to enable worker threads and dynamically load handlers.",
              );
            }

            ctx
              .connectRedis()
              .then(async () => {
                ctx.log.info("Redis module loaded");
                await ctx.register();
                ctx.log.info("Service registered in Redis");
                await ctx.heartbeat();
                ctx.log.info("Heartbeat started");

                process.on("SIGINT", () => {
                  ctx.log.info("SIGINT received. Shutting down gracefully...");
                  void ctx.shutdown();
                });
              })
              .catch((err) => {
                ctx.log.error(`Failed to load Redis module: ${err}`);
              });
            break;
          }
          case "mongoClient": {
            ctx.log.info("Connecting to MongoDB...");
            ctx
              .connectMongo()
              .then(() => {
                ctx.log.info("Mongo module loaded");
              })
              .catch((err) => {
                ctx.log.error(`Failed to connect to MongoDB: ${err}`);
                throw err;
              });
            break;
          }
          case "clickhouse": {
            ctx.log.info("Connecting to ClickHouse...");
            ctx
              .ensureClickhouseTables()
              .then(() => {
                ctx.log.info("ClickHouse module loaded");
              })
              .catch((err) => {
                ctx.log.error(`Failed to load ClickHouse module: ${err}`);
              });
            break;
          }
          default:
            ctx.log.info(`Unknown module ${key} during initialization.`);
        }
      }),
  ).then((results) => {
    results.forEach((result, index) => {
      const key = ctx.dependencyOrder[index];

      if (result.status === "fulfilled") {
        ctx.log.info(`Module "${key}" initialized successfully.`);
      } else {
        ctx.log.error(`Failed to initialize module "${key}": ${result.reason}`);
      }
    });

    if (ctx.dependencies.has("customDependencies")) {
      const customModules = ctx.dependencies.get(
        "customDependencies",
      ) as CustomModules;

      for (const module of customModules) {
        try {
          module.init(ctx.log as any);
        } catch (err) {
          ctx.log.error(
            `Failed to initialize custom module "${module.name}": ${err}`,
          );
        }
      }
    }
  });
}
