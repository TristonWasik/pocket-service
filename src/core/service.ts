import express, { Express, Router } from "express";
import { createClient, RedisClientType } from "redis";
import { Logger } from "winston";
import {
  AuthResolver,
  AuthStrategy,
  createAuthResolver,
  defaultHeaderAuthResolver,
  RouteDefinition,
} from "../api/express-types";
import { ClickhouseConfig, createTypedClickhouse } from "../modules/clickhouse";
import {
  createMongo,
  InferMongoCollections,
  MongoCollectionsConfig,
  MongoDatabase,
} from "../modules/mongo/mongo";
import { createLogger } from "./logger";
import { generateRandomHexString } from "./utils";
import { CustomModules, ExpressOptions } from "./types";
import {
  initializeDependencies,
  ServiceLifecycleContext,
} from "./service/lifecycle";
import { setupExpressApp, ServiceApiRuntimeContext } from "./service/api";
import {
  loadHandlers as loadWorkerHandlers,
  runWorkers as runWorkerRuntime,
} from "./service/workers";
import {
  addAuthStrategies,
  addAuthStrategy,
  addClickhouseDependency,
  addCustomModules,
  addMongoDependency,
  addRedisDependency,
  addRouterRegistration,
  addWorkerDependency,
  disableDefaultHeaderAuthFallback,
  disableExpress,
  setAuthResolver,
  setExpressOptions,
  ServiceConfigContext,
} from "./service/config";
import { shutdownService, ServiceShutdownContext } from "./service/shutdown";

export class Service<TCollections extends MongoCollectionsConfig = {}> {
  private static readonly CONFIG_SYNC_KEYS = {
    dependencyGraph: ["dependencies", "dependencyOrder"] as const,
    workers: ["serviceStreamSubscriptions", "workerCount"] as const,
    modules: ["dependencies", "dependencyOrder"] as const,
    expressMode: ["withoutExpressFlag"] as const,
    expressOptions: ["expressOptions"] as const,
    authStrategies: ["authStrategies"] as const,
    authResolver: ["authResolverOverride"] as const,
    authFallback: ["useDefaultHeaderAuthFallback"] as const,
    routers: ["routers"] as const,
  };

  private static readonly CONFIG_SYNC_UNIQUE_KEYS = [
    "dependencies",
    "dependencyOrder",
    "serviceStreamSubscriptions",
    "workerCount",
    "withoutExpressFlag",
    "expressOptions",
    "authStrategies",
    "authResolverOverride",
    "useDefaultHeaderAuthFallback",
    "routers",
  ] as const;

  private static readonly CONFIG_SYNC_ALL_KEYS =
    Service.CONFIG_SYNC_UNIQUE_KEYS;

  private static readonly CONFIG_SYNC_KEY_SET = new Set<string>(
    Service.CONFIG_SYNC_UNIQUE_KEYS,
  );

  private static isConfigSyncKey(
    key: string,
  ): key is (typeof Service.CONFIG_SYNC_UNIQUE_KEYS)[number] {
    return Service.CONFIG_SYNC_KEY_SET.has(key);
  }

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

  private toConfigContext(): ServiceConfigContext {
    return {
      dependencies: this.dependencies,
      dependencyOrder: this.dependencyOrder,
      log: this.log,
      withoutExpressFlag: this.withoutExpressFlag,
      expressOptions: this.expressOptions,
      authStrategies: this.authStrategies,
      authResolverOverride: this.authResolverOverride,
      useDefaultHeaderAuthFallback: this.useDefaultHeaderAuthFallback,
      serviceStreamSubscriptions: this.serviceStreamSubscriptions,
      workerCount: this.workerCount,
      routers: this.routers,
    };
  }

  private applyConfigContext(
    ctx: ServiceConfigContext,
    keys: readonly (keyof ServiceConfigContext)[] = Service.CONFIG_SYNC_ALL_KEYS,
  ) {
    for (const key of keys) {
      if (!Service.isConfigSyncKey(key)) {
        continue;
      }
      switch (key) {
        case "dependencies":
          this.dependencies = ctx.dependencies;
          break;
        case "dependencyOrder":
          this.dependencyOrder = ctx.dependencyOrder;
          break;
        case "serviceStreamSubscriptions":
          this.serviceStreamSubscriptions = ctx.serviceStreamSubscriptions;
          break;
        case "workerCount":
          this.workerCount = ctx.workerCount;
          break;
        case "withoutExpressFlag":
          this.withoutExpressFlag = ctx.withoutExpressFlag;
          break;
        case "expressOptions":
          this.expressOptions = ctx.expressOptions;
          break;
        case "authStrategies":
          this.authStrategies = ctx.authStrategies;
          break;
        case "authResolverOverride":
          this.authResolverOverride = ctx.authResolverOverride;
          break;
        case "useDefaultHeaderAuthFallback":
          this.useDefaultHeaderAuthFallback = ctx.useDefaultHeaderAuthFallback;
          break;
        case "routers":
          this.routers = ctx.routers;
          break;
      }
    }
  }

  private toShutdownContext(): ServiceShutdownContext {
    return {
      dependencies: this.dependencies,
      quitRedis: () => this.redis.quit(),
      disconnectMongo: () => this.mongo.disconnect(),
      closeClickhouse: () => this.clickhouse.client.close(),
      log: this.log,
      name: this.name,
      setStatus: (status) => {
        this._status = status;
      },
    };
  }

  private toLifecycleContext(): ServiceLifecycleContext {
    return {
      dependencyOrder: this.dependencyOrder,
      dependencies: this.dependencies,
      log: this.log,
      loadHandlers: () => this.loadHandlers(),
      runWorkers: () => this.runWorkers(),
      connectRedis: () => this.redis.connect(),
      register: () => this.register(),
      heartbeat: () => this.heartbeat(),
      shutdown: () => this.shutdown(),
      connectMongo: () => this.mongo.connect(),
      ensureClickhouseTables: () => this.clickhouse.ensureTables(),
    };
  }

  private toApiRuntimeContext(): ServiceApiRuntimeContext {
    return {
      withoutExpressFlag: this.withoutExpressFlag,
      expressOptions: this.expressOptions,
      api: this.withoutExpressFlag
        ? (undefined as unknown as Express)
        : this.api,
      routers: this.routers,
      fullUrl: this.fullUrl,
      port: this.port,
      log: this.log,
      name: this.name,
      getStatus: () => this.status,
      startedAt: this.startedAt,
      dependencies: this.dependencies,
      getRoutes: () => this.routes,
      getLoadedEventListeners: () => this.loadedEventListeners,
      handlers: this.handlers,
      getIsWorkerRunning: () => this.isWorkerRunning,
      streamKey: this.streamKey,
      simpleName: this.simpleName,
      getRedis: () => this.redis,
      getAuthResolver: () => this.getAuthResolver(),
      internalAddRouter: (base, router, routes) =>
        this.internalAddRouter(base, router, routes),
    };
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

      initializeDependencies(this.toLifecycleContext());
      setupExpressApp(this.toApiRuntimeContext());

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
    loadWorkerHandlers(
      this as unknown as Parameters<typeof loadWorkerHandlers>[0],
    );
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
    runWorkerRuntime(
      this as unknown as Parameters<typeof runWorkerRuntime>[0],
      { workerCount },
    );
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
    const ctx = this.toConfigContext();
    addMongoDependency(ctx, config);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.dependencyGraph);
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
    const ctx = this.toConfigContext();
    addClickhouseDependency(ctx, config);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.dependencyGraph);
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
    const ctx = this.toConfigContext();
    addRedisDependency(ctx, url);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.dependencyGraph);
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
    const ctx = this.toConfigContext();
    addWorkerDependency(ctx, workerCount, serviceStreams);
    this.applyConfigContext(ctx, [
      ...Service.CONFIG_SYNC_KEYS.dependencyGraph,
      ...Service.CONFIG_SYNC_KEYS.workers,
    ]);
    return this;
  }

  /**
   * Loads custom dependencies that can be used in the service. The factory functions will be called during build() after all other dependencies are loaded and can be used to initialize any custom logic or connections. The result of each factory function will be logged.
   * @param dependencies Object where keys are dependency names and values are factory functions that return a boolean indicating success or failure of initialization.
   */
  withModules(dependencies: CustomModules) {
    const ctx = this.toConfigContext();
    addCustomModules(ctx, dependencies);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.modules);
    return this;
  }

  withoutExpress() {
    const ctx = this.toConfigContext();
    disableExpress(ctx);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.expressMode);
    return this;
  }

  withExpressOptions(options: Partial<ExpressOptions>) {
    const ctx = this.toConfigContext();
    setExpressOptions(ctx, options);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.expressOptions);
    return this;
  }

  withAuthStrategy(strategy: AuthStrategy) {
    const ctx = this.toConfigContext();
    addAuthStrategy(ctx, strategy);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.authStrategies);
    return this;
  }

  withAuthStrategies(strategies: AuthStrategy[]) {
    const ctx = this.toConfigContext();
    addAuthStrategies(ctx, strategies);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.authStrategies);
    return this;
  }

  withAuthResolver(resolver: AuthResolver) {
    const ctx = this.toConfigContext();
    setAuthResolver(ctx, resolver);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.authResolver);
    return this;
  }

  withoutDefaultHeaderAuthFallback() {
    const ctx = this.toConfigContext();
    disableDefaultHeaderAuthFallback(ctx);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.authFallback);
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
    const ctx = this.toConfigContext();
    addRouterRegistration(ctx, base, router, routes);
    this.applyConfigContext(ctx, Service.CONFIG_SYNC_KEYS.routers);
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
    await shutdownService(this.toShutdownContext(), opts);
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
