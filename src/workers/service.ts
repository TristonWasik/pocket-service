import express, { Express, Router } from "express";
import { existsSync, readdirSync } from "fs";
import path from "path";
import { createClient, RedisClientType } from "redis";
import { Logger } from "winston";
import { Worker } from "worker_threads";
import {
  AuthResolver,
  AuthStrategy,
  createAuthResolver,
  createMetaRouter,
  defaultHeaderAuthResolver,
  RouteDefinition,
} from "./express-types";
import {
  ClickhouseConfig,
  createTypedClickhouse,
  defineClickhouseMethod,
} from "./db/clickhouse";
import {
  createMongo,
  InferMongoCollections,
  MongoCollectionsConfig,
  MongoDatabase,
} from "./db/mongo/mongo";
import { createLogger } from "./logger";
import { generateRandomHexString, getUseableDatesFromMs } from "./utils";
import { CustomModules, ExpressOptions } from "./types";
import cors from "cors";

export class Service<TCollections extends MongoCollectionsConfig = {}> {
  private name: string =
    process.env.SERVICE_NAME ?? generateRandomHexString(12);
  private url: string = process.env.SERVICE_URL ?? "http://localhost";
  private port: number = process.env.SERVICE_PORT
    ? Number(process.env.SERVICE_PORT)
    : 3100;
  private workerCount: number = 1;
  private handlers: Record<string, string> = {};
  private loadedEventListeners: string[] = [];
  private routers: {
    base: string;
    router: Router;
    routes?: RouteDefinition<any, any, boolean>[];
  }[] = [];
  private startedAt: number = Date.now();
  private dependencies: Map<string, unknown> = new Map<string, unknown>();
  private dependencyOrder: string[] = [];
  private isWorkerRunning: boolean = false;
  private serviceStreamSubscriptions: string[] = [];
  private _status: "starting" | "running" | "stopped" | "stopping" = "starting";
  private readonly HEARTBEAT_INTERVAL = 1000 * 5;
  private authStrategies: AuthStrategy[] = [];
  private authResolverOverride?: AuthResolver;
  private useDefaultHeaderAuthFallback = true;
  private expressOptions: ExpressOptions = {
    corsWhitelist: ["*"],
    asJson: true,
    customMiddleware: [],
  };
  private withoutExpressFlag: boolean = false;

  private getAuthResolver(): AuthResolver {
    if (this.authResolverOverride) {
      return this.authResolverOverride;
    }

    return createAuthResolver(this.authStrategies, {
      fallbackResolver: this.useDefaultHeaderAuthFallback
        ? (req) => defaultHeaderAuthResolver(req)
        : undefined,
    });
  }

  get streamKey() {
    return this.simpleName + ":events";
  }

  get simpleName() {
    return this.name.split("-")[0];
  }

  get fullUrl() {
    return `${this.url}:${this.port}`;
  }

  get api(): Express {
    if (this.withoutExpressFlag) {
      throw new Error(
        "Express server is disabled. Service built without Express.",
      );
    }
    if (!this.dependencies.has("expressApp")) {
      this.dependencies.set("expressApp", express());
    }
    return this.dependencies.get("expressApp") as Express;
  }

  get log(): Logger {
    if (!this.dependencies.has("logger")) {
      this.dependencies.set("logger", createLogger(this.name));
    }
    const logger = this.dependencies.get("logger");
    if (!(logger instanceof Logger)) {
      throw new Error("Logger is not of type Logger.");
    }
    return logger;
  }

  get routes() {
    return this.routers.flatMap(
      (r) =>
        r.routes?.map((route) => {
          const base = r.base === "/" ? "" : r.base;
          const fullPath = route.fullPath === "/" ? "" : route.fullPath;
          const combined =
            `${base}${fullPath}` === "" ? "/" : `${base}${fullPath}`;

          return {
            path: combined,
            method: route.method,
            requireAuth: route.requireAuth ?? false,
            meta: route.meta,
          };
        }) || [],
    );
  }

  get status() {
    return this._status;
  }

  /**
   * MongoDB client instance.
   *
   * @requires MongoDB module to be added via withMongo()
   */
  get mongo() {
    if (!this.dependencies.has("mongoClient")) {
      throw new Error("MongoDB module has not been added.");
    }
    return this.dependencies.get("mongoClient") as MongoDatabase<TCollections>;
  }

  /**
   * Typed MongoDB collection wrappers registered through `withMongo()`.
   *
   * @requires MongoDB module to be added via withMongo()
   */
  get db(): InferMongoCollections<TCollections> {
    if (!this.dependencies.has("mongoClient")) {
      throw new Error("MongoDB module has not been added.");
    }
    return this.mongo.collections;
  }

  /**
   * Clickhouse client instance. This will throw an error if Clickhouse module has not been added.
   *
   * @requires ClickhouseModule to be added via withClickhouse()
   * @beta
   */
  get clickhouse() {
    if (!this.dependencies.has("clickhouse")) {
      throw new Error("Clickhouse module has not been added.");
    }
    return this.dependencies.get("clickhouse") as ReturnType<
      typeof createTypedClickhouse
    >;
  }

  /**
   * Redis client instance. This will throw an error if Redis module has not been added.
   *
   * @requires RedisModule to be added via withRedis()
   */
  get redis(): RedisClientType {
    if (!this.dependencies.has("redis")) {
      throw new Error("Redis module has not been added.");
    }
    return this.dependencies.get("redis") as RedisClientType;
  }

  /**
   * Registers the service in Redis for service discovery.
   *
   * @requires RedisModule to be added via withRedis()
   */
  async register() {
    if (!this.dependencies.has("redis")) {
      this.log.warn(
        "Redis module not initialized. Call withRedis() to enable service registration.",
      );
      return;
    }
    const key = `services:registry:${this.name}`;
    const value = JSON.stringify({
      name: this.name,
      streamKey: this.streamKey,
      url: this.fullUrl,
      dependencies: Object.keys(this.dependencies),
      routes: this.routes,
      lastHeartbeat: Date.now(),
    });

    await this.redis.set(key, value, {
      EX: 30, // TTL of 30 seconds
    });
  }

  /**
   * Periodically update the service registration in Redis.
   *
   * @requires RedisModule to be added via withRedis()
   */
  async heartbeat() {
    if (!this.dependencies.has("redis")) {
      this.log.warn(
        "Redis module not initialized. Call withRedis() to enable heartbeat.",
      );
      return;
    }
    setInterval(async () => {
      await this.register();
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Builds and starts the service by initializing dependencies, setting up routes, and starting the API server.
   *
   * The build process includes:
   * 1. Initializing dependencies in the order they were added (MongoDB, Redis, Clickhouse). This includes the redis workers module if withWorkers() was called.
   * 2. Initializing any custom modules provided through withModules().
   * 3. Setting up Express middleware and CORS based on provided options.
   * 4. Registering default routes like /health and /workers.
   * 5. Registering any custom routers added through addRouter().
   * 6. Starting the Express server on the configured port.
   */
  build() {
    try {
      this._status = "starting";

      Promise.allSettled(
        this.dependencyOrder
          .filter((f) => f !== "customDependencies")
          .map((key) => {
            switch (key) {
              case "redis": {
                if (this.dependencies.has("workers")) {
                  this.loadHandlers();
                  this.runWorkers();
                } else {
                  this.log.warn(
                    "Worker module not initialized. Call withWorkers() to enable worker threads and dynamically load handlers.",
                  );
                }

                this.redis
                  .connect()
                  .then(async () => {
                    this.log.info("Redis module loaded");
                    this.register();
                    this.log.info("Service registered in Redis");
                    this.heartbeat();
                    this.log.info("Heartbeat started");

                    process.on("SIGINT", () => {
                      this.log.info(
                        "SIGINT received. Shutting down gracefully...",
                      );
                      this.shutdown();
                    });
                  })
                  .catch((err) => {
                    this.log.error(`Failed to load Redis module: ${err}`);
                  });
                break;
              }
              case "mongoClient": {
                this.log.info("Connecting to MongoDB...");
                this.mongo
                  .connect()
                  .then(() => {
                    this.log.info("Mongo module loaded");
                  })
                  .catch((err) => {
                    this.log.error(`Failed to connect to MongoDB: ${err}`);
                    throw err;
                  });
                break;
              }
              case "clickhouse": {
                this.log.info("Connecting to ClickHouse...");
                this.clickhouse
                  .ensureTables()
                  .then(() => {
                    this.log.info("ClickHouse module loaded");
                  })
                  .catch((err) => {
                    this.log.error(`Failed to load ClickHouse module: ${err}`);
                  });
                break;
              }
              default:
                this.log.info(`Unknown module ${key} during initialization.`);
            }
          }),
      ).then((results) => {
        results.forEach((result, index) => {
          const key = this.dependencyOrder[index];

          if (result.status === "fulfilled") {
            this.log.info(`Module "${key}" initialized successfully.`);
          } else {
            this.log.error(
              `Failed to initialize module "${key}": ${result.reason}`,
            );
          }
        });

        if (this.dependencies.has("customDependencies")) {
          const customModules = this.dependencies.get(
            "customDependencies",
          ) as CustomModules;

          for (const module of customModules) {
            try {
              module.init(this.log);
            } catch (err) {
              this.log.error(
                `Failed to initialize custom module "${module.name}": ${err}`,
              );
            }
          }
        }
      });

      if (this.withoutExpressFlag) {
        this.log.warn(
          "Express server is disabled. Service built without Express.",
        );
      } else {
        if (this.expressOptions.asJson) {
          this.log.info("Configuring Express to parse JSON bodies");
          this.api.use(express.json());
        }

        for (const mw of this.expressOptions.customMiddleware || []) {
          this.log.info("Adding custom middleware to Express");
          this.api.use(mw);
        }

        if ("corsWhitelist" in this.expressOptions) {
          this.log.info(
            "Configuring CORS with whitelist: " +
              this.expressOptions.corsWhitelist,
          );
          this.api.use(
            cors({
              origin: this.expressOptions.corsWhitelist,
              credentials: this.expressOptions.credentials,
            }),
          );
        } else if ("corsFn" in this.expressOptions) {
          this.log.info("Configuring CORS with function");
          this.api.use(
            cors({
              origin: this.expressOptions.corsFn,
              credentials: this.expressOptions.credentials,
            }),
          );
        }

        // routers
        if (!this.expressOptions.omitDefaultRoutes) {
          this.registerDefaultRoutes();
        }
        this.log.info(`Registering ${this.routers.length} routers`);
        this.routers.forEach(({ base, router }) => {
          this.api.use(base, router);
        });
        this.log.info(
          "Routers registered:" +
            this.routers
              .map((rt) => {
                const maxMethodLength = rt.routes
                  ? Math.max(...rt.routes?.map((r) => r.method.length))
                  : 0;
                const maxPathLength = rt.routes
                  ? Math.max(...rt.routes?.map((r) => r.fullPath.length))
                  : 0;
                const maxAuthLength = rt.routes
                  ? Math.max(...rt.routes?.map((r) => (r.requireAuth ? 6 : 8)))
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

        this.api.listen(this.port, () => {
          this.log.info(`API listening at ${this.fullUrl}`);
        });
      }

      this._status = "running";
      return this;
    } catch (err) {
      this.log.error(`Failed to build service: ${err}`);
      throw err;
    }
  }

  /**
   * Reads all files in the src/handlers directory and imports them dynamically.
   */
  private loadHandlers() {
    if (!this.dependencies.has("redis")) {
      this.log.warn("Redis module not initialized. Skipping handler loading.");
      return;
    }
    const handlersDir = path.resolve(process.cwd(), "src/handlers");
    if (!existsSync(handlersDir)) {
      this.log.warn("Handlers directory does not exist.");
      return;
    }

    const files = readdirSync(handlersDir).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".js"),
    );

    for (const file of files) {
      const modulePath = path.join(handlersDir, file);
      this.handlers[path.basename(file, path.extname(file))] = modulePath;
    }

    this.log.info(`Loaded ${Object.keys(this.handlers).length} handlers:`);
    for (const handlerName of Object.keys(this.handlers)) {
      this.log.info(`- ${handlerName}`);
    }
  }

  /**
   * Registers default routes like /health and /workers
   */
  private registerDefaultRoutes() {
    this.initBaseRoutes();
    if (this.dependencies.has("redis") && this.dependencies.has("workers")) {
      this.log.info(
        "Redis and handler modules detected. Registering worker routes.",
      );
      this.initWorkerRoutes();
    }

    this.log.info("Default routes registered.");
  }

  private initBaseRoutes() {
    this.log.info("Registering base routes");
    const { router, routes, addRoute } = createMetaRouter({
      authResolver: this.getAuthResolver(),
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
        res.send('OK from "' + this.name + '" service');
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
          service: this.name,
          status: this.status,
          startedAt: new Date(this.startedAt),
          uptime: getUseableDatesFromMs(Math.floor(process.uptime() * 1000)),
          workerRunning: this.isWorkerRunning,
          modulesLoaded: Array.from(this.dependencies.keys())
            .filter((f) => f !== "customDependencies")
            .concat(
              Array.from(
                this.dependencies.has("customDependencies")
                  ? (
                      this.dependencies.get(
                        "customDependencies",
                      ) as CustomModules
                    ).map((d) => `custom:${d.name}`)
                  : [],
              ),
            ),
          routesLoaded: this.routes,
          handlersLoaded: this.loadedEventListeners,
        });
      },
    );

    this.internalAddRouter("/", router, routes);
  }

  /**
   * Default worker routes under /workers
   */
  private initWorkerRoutes(): void {
    const { router, routes, addRoute } = createMetaRouter({
      authResolver: this.getAuthResolver(),
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
          status: this.isWorkerRunning ? "Running" : "Stopped",
          handlersLoaded: Object.keys(this.handlers),
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
        if (!this.redis) {
          return res.status(500).json({ error: "Redis client not connected" });
        }
        const messages = await this.redis.xRange(this.streamKey, "-", "+", {
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
        if (!this.redis) {
          return res.status(500).json({ error: "Redis client not connected" });
        }
        const result = await this.redis.xAck(
          stream,
          `${this.simpleName}:consumer-group`,
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
        if (!this.redis) {
          return res.status(500).json({ error: "Redis client not connected" });
        }
        const messages = await this.redis.xRange(this.streamKey, "-", "+", {
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
        if (!this.redis) {
          return res.status(500).json({ error: "Redis client not connected" });
        }
        const dlqMessage = await this.redis.xRange(stream, id, id);
        if (dlqMessage.length === 0 || dlqMessage[0].id !== id) {
          return res.status(404).json({ error: "Message not found in DLQ" });
        }
        const result = await this.redis.xAdd(
          stream,
          `${this.simpleName}:consumer-group`,
          dlqMessage[0].message,
        );
        res.json({ status: "Message retried", result });
      },
    );

    this.internalAddRouter("/workers", router, routes);
  }

  /**
   * Spawns worker threads to process messages from Redis streams.
   * Each worker thread runs the worker-thread.ts file.
   * Each worker thread is passed the service name, redis URL, and handlers.
   * Workers communicate back via parentPort to log messages.
   */
  private runWorkers(
    { workerCount }: { workerCount: number } = { workerCount: 1 },
  ) {
    if (!this.name) {
      this.log.error("Service name is not set. Cannot start workers.");
      return;
    }

    if (!this.dependencies.has("redis")) {
      this.log.warn("Redis module not initialized. Skipping worker setup.");
      return;
    }

    if (isNaN(workerCount) || workerCount < 1) {
      throw new Error("Worker count must be a number greater than 0.");
    }
    this.workerCount = workerCount < 1 ? 1 : workerCount;

    for (let i = 0; i < workerCount; i++) {
      const workerThread = new Worker(
        new URL("./worker-thread.js", import.meta.url),
        {
          workerData: {
            name: this.name,
            redisUrl: this.redis.options?.url,
            handlers: this.handlers,
            index: i,
            subscriptions: this.serviceStreamSubscriptions ?? [
              `${this.name}:events`,
            ],
          },
        },
      );

      this.isWorkerRunning = true;

      workerThread.on("error", (err) => {
        this.log.error(`Worker ${i} error: ${err.message}`);
      });

      workerThread.on("message", (msg) => {
        switch (msg.level) {
          case "info":
            this.log.info(msg.message);
            break;
          case "warn":
            this.log.warn(msg.message);
            break;
          case "error":
            this.log.error(msg.message);
            break;
          case "create":
            this.loadedEventListeners = msg.message;
            break;
          default:
            this.log.info(msg.message);
        }
      });

      workerThread.on("exit", (code) => {
        if (code !== 0) {
          this.log.error(`Worker ${i} stopped with exit code ${code}`);
        } else {
          this.log.info(`Worker ${i} exited gracefully.`);
        }
        this.isWorkerRunning = false;
      });

      this.log.info(`Worker ${i} started for service ${this.name}`);
    }
  }

  /**
   * The MongoDB module. This is initialized by calling withMongo() and provides access to the configured MongoDB collections through the `db` property. The MongoDB client will automatically connect when the service is built.
   *
   * @param config MongoDB configuration including URI, database name, and collections.
   *
   * @example
   * const t = new Service()
   *   .withMongo({
   *     dbName: "test",
   *     collections: {
   *       users: { schema: z.object({ id: z.string(), name: z.string() }) },
   *     },
   *   })
   *   .build();
   *
   * const l = await t.db.users.get({ id: "123" });
   */
  withMongo<TNextCollections extends MongoCollectionsConfig>(config: {
    dbName: string;
    uri?: string;
    collections: TNextCollections;
  }) {
    if (!this.dependencies.has("mongoClient")) {
      const mongo = createMongo(config.dbName, config.collections, {
        uri: config.uri,
      });
      this.dependencies.set("mongoClient", mongo);
      this.dependencyOrder.push("mongoClient");
    }
    return this as unknown as Service<TNextCollections>;
  }

  /**
   * The Clickhouse module. This is initialized by calling withClickhouse() and provides access to the configured Clickhouse tables through the `clickhouse` property. The Clickhouse client will automatically connect when the service is built.
   *
   * This module is a **WIP**.
   *
   * @param config Clickhouse configuration including tables.
   * @beta
   */
  withClickhouse<TTables extends Record<string, any>>(
    config: ClickhouseConfig<TTables>,
  ) {
    if (!this.dependencies.has("clickhouse")) {
      this.dependencies.set("clickhouse", createTypedClickhouse(config));
      this.dependencyOrder.push("clickhouse");
    }
    return this as Service<TCollections> & {
      clickhouse: ReturnType<typeof createTypedClickhouse<TTables>>;
    };
  }

  /**
   * Optional. Port number for the express server.
   *
   * Defaults in the following order:
   * 1. PORT environment variable
   * 2. 3100
   *
   * @param port port number
   */
  withPort(port: number = Number(process.env.PORT) || 3100) {
    this.port = port;
    return this;
  }

  /**
   * Optional. Base URL without port.
   *
   * Defaults in the following order:
   * 1. SERVICE_URL environment variable
   * 2. "http://localhost"
   *
   * @param url base url without port
   */
  withUrl(url: string) {
    this.url = url;
    return this;
  }

  /**
   * Optional. Name of the service. Used for logging and service discovery.
   *
   * Defaults in the following order:
   * 1. SERVICE_NAME environment variable
   * 2. A random hex string
   * @param name Name of the service
   */
  withName(name: string) {
    this.name = name;
    return this;
  }

  /**
   * The Redis module. This is initialized by calling withRedis() and provides a Redis client instance through the `redis` property. The Redis client will automatically connect when the service is built.
   * @param url Redis URL. Defaults to: redis://redis:6379
   */
  withRedis(url: string = "redis://redis:6379") {
    if (!this.dependencies.has("redis")) {
      this.dependencies.set("redis", createClient({ url }));
      this.dependencyOrder.push("redis");
    }
    return this;
  }

  /**
   * Adds worker threads to the service. These are used to process messages from Redis streams. Worker threads will be spawned when build() is called. This must be called after withRedis() to work properly.
   *
   * **Note**: This will not initialize without at least one service stream.
   * @param workerCount Defaults to 1
   * @param serviceStreams Defaults to empty array
   * @returns
   */
  withWorkers(workerCount: number, serviceStreams: string[] = []) {
    if (!this.dependencies.has("redis")) {
      this.log.warn(
        "Redis module not initialized. Call withRedis() before setting worker subscriptions.",
      );
      return this;
    }
    if (!this.dependencies.has("workers") && serviceStreams.length > 0) {
      this.dependencies.set("workers", true);
      this.serviceStreamSubscriptions = serviceStreams;
      this.workerCount = workerCount < 1 ? 1 : workerCount;
      this.dependencyOrder.push("workers");
    }
    return this;
  }

  /**
   * Loads custom dependencies that can be used in the service. The factory functions will be called during build() after all other dependencies are loaded and can be used to initialize any custom logic or connections. The result of each factory function will be logged.
   * @param dependencies Object where keys are dependency names and values are factory functions that return a boolean indicating success or failure of initialization.
   */
  withModules(dependencies: CustomModules) {
    if (!this.dependencies.has("customDependencies")) {
      this.dependencies.set(
        "customDependencies",
        dependencies.map((dep) => ({
          name: dep.name,
          init: dep.init,
          shutdown: dep.shutdown,
        })),
      );
      this.dependencyOrder.push("customDependencies");
    }
    return this;
  }

  withoutExpress() {
    this.withoutExpressFlag = true;
    return this;
  }

  withExpressOptions(options: Partial<ExpressOptions>) {
    if (this.withoutExpressFlag) {
      this.log.warn(
        "Express server is disabled. Express options will not be applied.",
      );
      return this;
    }
    this.expressOptions = { ...this.expressOptions, ...options };
    return this;
  }

  withAuthStrategy(strategy: AuthStrategy) {
    if (this.withoutExpressFlag) {
      this.log.warn(
        "Express server is disabled. Auth strategies will not be applied.",
      );
      return this;
    }
    this.authStrategies.push(strategy);
    return this;
  }

  withAuthStrategies(strategies: AuthStrategy[]) {
    if (this.withoutExpressFlag) {
      this.log.warn(
        "Express server is disabled. Auth strategies will not be applied.",
      );
      return this;
    }
    this.authStrategies.push(...strategies);
    return this;
  }

  withAuthResolver(resolver: AuthResolver) {
    if (this.withoutExpressFlag) {
      this.log.warn(
        "Express server is disabled. Auth resolver will not be applied.",
      );
      return this;
    }
    this.authResolverOverride = resolver;
    return this;
  }

  withoutDefaultHeaderAuthFallback() {
    this.useDefaultHeaderAuthFallback = false;
    return this;
  }

  private internalAddRouter(
    base: string,
    router: Router,
    routes: RouteDefinition<any, any, boolean>[] = [],
  ) {
    this.routers.push({ base, router, routes });
    return this;
  }

  /**
   * Registers an express router under a base path.
   * @param base Base path for this router.
   * @param router Router instance.
   * @param routes List of route definitions.
   * @returns
   */
  addRouter(
    base: string,
    router: Router,
    routes: RouteDefinition<any, any, boolean>[] = [],
  ) {
    if (this.withoutExpressFlag) {
      this.log.warn(
        "Express server is disabled. Routers will not be registered.",
      );
      return this;
    }
    if (base === "/") {
      this.log.warn("Base path '/' is not allowed. Skipping.");
      return this;
    }
    this.internalAddRouter(base, router, routes);
    return this;
  }

  /**
   * Gracefully shuts down the service by closing all connections and active workers.
   */
  async shutdown(
    opts: {
      /**
       * Optional callback to run before shutdown. Can be used to perform cleanup tasks like closing database connections, etc.
       */
      beforeShutdown?: () => Promise<void>;
      /**
       * Optional callback to run after shutdown. Can be used to perform any final tasks before the process exits.
       */
      afterShutdown?: () => Promise<void>;
    } = {},
  ) {
    await opts.beforeShutdown?.();
    this._status = "stopping";
    if (this.dependencies.has("redis")) {
      await this.redis.quit();
    }
    if (this.dependencies.has("mongoClient")) {
      await this.mongo.disconnect();
    }
    if (this.dependencies.has("clickhouse")) {
      await this.clickhouse.client.close();
    }
    if (this.dependencies.has("customDependencies")) {
      for (const dep of this.dependencies.get(
        "customDependencies",
      ) as CustomModules) {
        if (dep.shutdown) {
          try {
            const result = await dep.shutdown(this.log);
            this.log.info(
              `Custom dependency "${dep.name}" shutdown with result: ${result}`,
            );
          } catch (err) {
            this.log.error(
              `Failed to shutdown custom dependency "${dep.name}": ${err}`,
            );
          }
        }
      }
    }
    this.log.info(`Service ${this.name} shutting down.`);
    this._status = "stopped";
    await opts.afterShutdown?.();
    process.exit(0);
  }

  [Symbol.dispose]() {
    this.shutdown();
  }

  *[Symbol.iterator]() {
    for (const dependency of Object.values(this.dependencies)) {
      yield dependency;
    }
  }
}
