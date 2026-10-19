import { Server } from "http";
import express, { Express, Router } from "express";
import { RedisClientType } from "redis";
import z, { output, ZodType } from "zod";
import { Logger } from "winston";
import {
  AuthResolver,
  AuthStrategy,
  createAuthResolver,
  defaultHeaderAuthResolver,
  AnyRouteDefinition,
} from "../api/express-types";
import { ClickhouseConfig, createTypedClickhouse } from "../modules/clickhouse";
import {
  InferMongoCollections,
  MongoCollectionsConfig,
  MongoDatabase,
} from "../modules/mongo/mongo";
import { createLogger } from "./logger";
import { generateRandomHexString } from "./utils";
import { CustomModules, ExpressOptions, ServiceStatus } from "./types";
import { startService } from "./service/lifecycle";
import {
  encodeEvent,
  EventDefinition,
  EventInput,
} from "../runtime/events";
import {
  closeHttpServer,
  ReadinessCheck,
  setupExpressApp,
  startHttpServer,
} from "./service/api";
import { startWorkers, WorkerOptions, WorkerPool } from "./service/workers";
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
  INTERNAL_DEPENDENCIES,
  ServiceState,
} from "./service/config";
import { shutdownService, ShutdownOptions } from "./service/shutdown";
import type { OpenApiOptions } from "../api/openapi";
import {
  createMemoryRateLimitStore,
  createRateLimiter,
  createRedisRateLimitStore,
  RateLimiter,
  RateLimitOptions,
} from "../api/rate-limit";
import { createDiscovery, Discovery, REGISTRY_PREFIX } from "./discovery";

const DEFAULT_PORT = 3100;
const HEARTBEAT_INTERVAL_MS = 5_000;
const REGISTRY_TTL_SECONDS = 30;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

function envPort() {
  return Number(process.env.SERVICE_PORT ?? process.env.PORT) || DEFAULT_PORT;
}

export class Service<
  TCollections extends MongoCollectionsConfig = {},
  TEnv = {},
> {
  private name: string =
    process.env.SERVICE_NAME ?? generateRandomHexString(12);
  private url: string = process.env.SERVICE_URL ?? "http://localhost";
  private port: number = envPort();
  private startedAt: number = Date.now();
  private _status: ServiceStatus = "starting";

  private readonly state: ServiceState = {
    dependencies: new Map<string, unknown>(),
    dependencyOrder: [],
    log: {
      info: (message) => this.log.info(message),
      warn: (message) => this.log.warn(message),
      error: (message) => this.log.error(message),
    },
    withoutExpressFlag: false,
    expressOptions: {
      corsWhitelist: ["*"],
      asJson: true,
      customMiddleware: [],
    },
    authStrategies: [],
    authResolverOverride: undefined,
    useDefaultHeaderAuthFallback: true,
    serviceStreamSubscriptions: [],
    workerCount: 1,
    routers: [],
  };

  private workerPool: WorkerPool | null = null;
  private server: Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private buildPromise: Promise<this> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private signalHandlersEnabled = true;
  private shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  private signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
  private envValues: { parsed: unknown } | null = null;
  private discoveryClient: Discovery | null = null;

  private get dependencies() {
    return this.state.dependencies;
  }

  private getAuthResolver(): AuthResolver {
    if (this.state.authResolverOverride) {
      return this.state.authResolverOverride;
    }

    return createAuthResolver(this.state.authStrategies, {
      fallbackResolver: this.state.useDefaultHeaderAuthFallback
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
    if (this.state.withoutExpressFlag) {
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
    return this.state.routers.flatMap(
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
   * Environment values parsed by `withEnv()`.
   */
  get env(): TEnv {
    if (!this.envValues) {
      throw new Error("withEnv() has not been called.");
    }
    return this.envValues.parsed as TEnv;
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
   * Validates and publishes a typed event defined with `defineEvent()`, and
   * resolves with the new stream entry ID. Throws if the payload does not
   * match the event's schema.
   *
   * @requires RedisModule to be added via withRedis()
   * @param options.maxLen Approximately trim the stream to this many entries.
   */
  async publish<TEvent extends EventDefinition>(
    event: TEvent,
    data: EventInput<TEvent>,
    options: { maxLen?: number } = {},
  ): Promise<string> {
    const { stream, fields } = encodeEvent(event, data);
    return this.redis.xAdd(
      stream,
      "*",
      fields,
      options.maxLen === undefined
        ? undefined
        : {
            TRIM: {
              strategy: "MAXLEN",
              strategyModifier: "~",
              threshold: options.maxLen,
            },
          },
    );
  }

  /**
   * Dependency checks run by `GET /health/ready`.
   */
  private readinessChecks(): Record<string, ReadinessCheck> {
    const checks: Record<string, ReadinessCheck> = {};
    if (this.dependencies.has("redis")) {
      checks.redis = () => this.redis.ping();
    }
    if (this.dependencies.has("mongoClient")) {
      checks.mongo = () => this.mongo.db.command({ ping: 1 });
    }
    if (this.dependencies.has("clickhouse")) {
      checks.clickhouse = async () => {
        const result = await this.clickhouse.client.ping();
        if (!result.success) throw result.error;
      };
    }
    const customModules =
      (this.dependencies.get("customDependencies") as
        | CustomModules
        | undefined) ?? [];
    for (const module of customModules) {
      if (!module.ready) continue;
      checks[`custom:${module.name}`] = async () => {
        if ((await module.ready!()) === false) {
          throw new Error("Not ready");
        }
      };
    }
    return checks;
  }

  private get registryKey() {
    return `${REGISTRY_PREFIX}${this.name}`;
  }

  /**
   * Looks up and calls other services through the Redis service registry.
   *
   * @requires RedisModule to be added via withRedis()
   */
  get discovery(): Discovery {
    this.discoveryClient ??= createDiscovery(
      this.redis,
      HEARTBEAT_INTERVAL_MS,
    );
    return this.discoveryClient;
  }

  private createRateLimiter(): RateLimiter | undefined {
    const options = this.state.rateLimits;
    if (!options) return undefined;

    const hasRedis = this.dependencies.has("redis");
    if (!hasRedis) {
      this.log.warn(
        "Rate limiting without Redis uses per-process counters; limits are not shared across instances.",
      );
    }
    return createRateLimiter({
      options,
      store: hasRedis
        ? createRedisRateLimitStore(this.redis)
        : createMemoryRateLimitStore(),
      prefix: `ratelimit:${this.name}`,
      log: this.state.log,
    });
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
    const value = JSON.stringify({
      name: this.name,
      streamKey: this.streamKey,
      url: this.fullUrl,
      dependencies: [...this.dependencies.keys()].filter(
        (key) => !INTERNAL_DEPENDENCIES.has(key),
      ),
      routes: this.routes,
      lastHeartbeat: Date.now(),
    });

    await this.redis.set(this.registryKey, value, {
      EX: REGISTRY_TTL_SECONDS,
    });
  }

  /**
   * Periodically refreshes the service registration in Redis. Started by
   * build(); calling it again has no effect.
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
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.register().catch((err) =>
        this.log.error(`Heartbeat failed: ${err}`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.dependencies.has("redis") && this.redis.isOpen) {
      await this.redis.del(this.registryKey);
    }
  }

  /**
   * Starts the service and resolves once it is ready to serve traffic.
   *
   * 1. Configures Express middleware, CORS, default routes and your routers.
   * 2. Connects Redis, MongoDB and ClickHouse concurrently.
   * 3. Runs custom module `init` hooks in order.
   * 4. Starts workers, registers the service in Redis and starts the heartbeat.
   * 5. Starts the HTTP server.
   *
   * If any step fails, everything already started is shut down and the
   * returned promise rejects. Calling build() again returns the same promise.
   */
  build(): Promise<this> {
    this.buildPromise ??= this.start();
    return this.buildPromise;
  }

  private async start(): Promise<this> {
    this._status = "starting";
    try {
      if (!this.state.withoutExpressFlag) {
        setupExpressApp({
          ...this.state,
          rateLimiter: this.createRateLimiter(),
          logger: this.log,
          api: this.api,
          name: this.name,
          getStatus: () => this.status,
          startedAt: this.startedAt,
          getRoutes: () => this.routes,
          getLoadedEventListeners: () => this.workerPool?.loadedHandlers ?? [],
          getIsWorkerRunning: () => this.workerPool?.isRunning ?? false,
          getWorkerStatus: () => this.workerPool?.status ?? [],
          workerSubscriptions: this.state.serviceStreamSubscriptions,
          getRedis: () => this.redis,
          getAuthResolver: () => this.getAuthResolver(),
          getReadinessChecks: () => this.readinessChecks(),
          internalAddRouter: (base, router, routes) => {
            this.state.routers.push({ base, router, routes });
          },
        });
      }

      await startService({
        dependencies: this.dependencies,
        log: this.state.log,
        connectRedis: () => this.redis.connect(),
        connectMongo: () => this.mongo.connect(),
        ensureClickhouseTables: () => this.clickhouse.ensureTables(),
        startWorkers: () => {
          this.workerPool = startWorkers({
            name: this.name,
            dependencies: this.dependencies,
            log: this.state.log,
            redisUrl: this.redis.options?.url,
          });
        },
        register: () => this.register(),
        startHeartbeat: () => void this.heartbeat(),
        startHttp: async () => {
          if (this.state.withoutExpressFlag) return;
          this.server = await startHttpServer({
            api: this.api,
            port: this.port,
            fullUrl: this.fullUrl,
            log: this.state.log,
          });
        },
      });

      this._status = "running";
      this.installSignalHandlers();
      return this;
    } catch (err) {
      this.log.error(`Failed to build service: ${err}`);
      await this.shutdown();
      throw err;
    }
  }

  private installSignalHandlers() {
    if (!this.signalHandlersEnabled || this.signalHandler) return;

    this.signalHandler = (signal) => {
      this.log.info(`${signal} received. Shutting down gracefully...`);
      setTimeout(() => {
        this.log.error(
          `Shutdown did not finish within ${this.shutdownTimeoutMs}ms. Forcing exit.`,
        );
        process.exit(1);
      }, this.shutdownTimeoutMs).unref();

      this.shutdown().then(
        () => process.exit(0),
        (err) => {
          this.log.error(`Shutdown failed: ${err}`);
          process.exit(1);
        },
      );
    };
    process.once("SIGINT", this.signalHandler);
    process.once("SIGTERM", this.signalHandler);
  }

  private removeSignalHandlers() {
    if (!this.signalHandler) return;
    process.off("SIGINT", this.signalHandler);
    process.off("SIGTERM", this.signalHandler);
    this.signalHandler = null;
  }

  /**
   * The MongoDB module. This is initialized by calling withMongo() and provides access to the configured MongoDB collections through the `db` property. The MongoDB client will automatically connect when the service is built.
   *
   * @param config MongoDB configuration including URI, database name, and collections.
   *
   * @example
   * const t = await new Service()
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
    addMongoDependency(this.state, config);
    return this as unknown as Service<TNextCollections, TEnv>;
  }

  /**
   * The Clickhouse module. This is initialized by calling withClickhouse() and provides access to the configured Clickhouse tables through the `clickhouse` property. Tables are created when the service is built.
   *
   * This module is a **WIP**.
   *
   * @param config Clickhouse configuration including tables.
   * @beta
   */
  withClickhouse<TTables extends Record<string, any>>(
    config: ClickhouseConfig<TTables>,
  ) {
    addClickhouseDependency(this.state, config);
    return this as Service<TCollections, TEnv> & {
      clickhouse: ReturnType<typeof createTypedClickhouse<TTables>>;
    };
  }

  /**
   * Validates environment variables with a Zod schema and exposes the typed
   * result as `service.env`. Parsing happens immediately, so the values can be
   * used by later builder calls; invalid values throw with a readable list of
   * problems.
   *
   * @example
   * const service = new Service().withEnv(
   *   z.object({ REDIS_URL: z.url(), WORKERS: z.coerce.number().default(2) }),
   * );
   * service.withRedis(service.env.REDIS_URL);
   *
   * @param schema Zod schema for the environment.
   * @param source Values to parse. Defaults to `process.env`.
   */
  withEnv<TSchema extends ZodType>(
    schema: TSchema,
    source: Record<string, string | undefined> = process.env,
  ): Service<TCollections, output<TSchema>> {
    const result = schema.safeParse(source);
    if (!result.success) {
      throw new Error(
        `Invalid environment variables:\n${z.prettifyError(result.error)}`,
      );
    }
    this.envValues = { parsed: result.data };
    return this as unknown as Service<TCollections, output<TSchema>>;
  }

  /**
   * Optional. Port number for the express server.
   *
   * Defaults in the following order:
   * 1. SERVICE_PORT environment variable
   * 2. PORT environment variable
   * 3. 3100
   *
   * @param port port number
   */
  withPort(port: number = envPort()) {
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
   *
   * Defaults in the following order:
   * 1. REDIS_URL environment variable
   * 2. "redis://redis:6379"
   *
   * @param url Redis URL.
   */
  withRedis(url: string = process.env.REDIS_URL ?? "redis://redis:6379") {
    addRedisDependency(this.state, url);
    return this;
  }

  /**
   * Adds worker threads that consume Redis streams through a consumer group.
   * Worker threads are spawned when build() is called. Must be called after withRedis().
   *
   * Handlers run in separate threads with their own Redis connection, so they
   * cannot use this service's Mongo/ClickHouse clients. Pass connection info via `options.config`.
   *
   * **Note**: This will not initialize without at least one service stream.
   * @param workerCount Number of worker threads.
   * @param serviceStreams Streams to consume, e.g. `["auth:events"]`.
   * @param options Handler directory, retry/timeout tuning, and handler config.
   */
  withWorkers(
    workerCount: number,
    serviceStreams: string[] = [],
    options: WorkerOptions = {},
  ) {
    addWorkerDependency(this.state, workerCount, serviceStreams, options);
    return this;
  }

  /**
   * Registers custom modules. Each `init` runs during build() after the core modules connect, in the order given; returning `false` or throwing fails the build. `shutdown` hooks run in reverse order.
   * @param dependencies Modules with a name, an `init` hook and an optional `shutdown` hook.
   */
  withModules(dependencies: CustomModules) {
    addCustomModules(this.state, dependencies);
    return this;
  }

  withoutExpress() {
    disableExpress(this.state);
    return this;
  }

  withExpressOptions(options: Partial<ExpressOptions>) {
    setExpressOptions(this.state, options);
    return this;
  }

  withAuthStrategy(strategy: AuthStrategy) {
    addAuthStrategy(this.state, strategy);
    return this;
  }

  withAuthStrategies(strategies: AuthStrategy[]) {
    addAuthStrategies(this.state, strategies);
    return this;
  }

  withAuthResolver(resolver: AuthResolver) {
    setAuthResolver(this.state, resolver);
    return this;
  }

  withoutDefaultHeaderAuthFallback() {
    disableDefaultHeaderAuthFallback(this.state);
    return this;
  }

  /**
   * Enables rate limiting. Routes pick a tier with `meta.rateLimit`
   * (`"standard"`, `"strict"` or `"none"`); routes without one use
   * `options.default`, which is `"none"` unless set. Counters live in Redis
   * when the service has it, so limits are shared across instances.
   *
   * @example
   * new Service()
   *   .withRedis()
   *   .withRateLimits({ strict: { limit: 5, windowMs: 60_000 } });
   */
  withRateLimits(options: RateLimitOptions = {}) {
    this.state.rateLimits = options;
    return this;
  }

  /**
   * Serves an OpenAPI 3.1 document (default path `/openapi.json`) generated
   * from your routers' definitions and Zod validators.
   *
   * @param options Document path, info, servers and security schemes.
   */
  withOpenApi(options: OpenApiOptions = {}) {
    this.state.openApi = options;
    return this;
  }

  /**
   * Controls the built-in SIGINT/SIGTERM handling. When enabled (the default),
   * the first signal runs shutdown() and then exits the process, forcing an
   * exit if shutdown takes longer than `shutdownTimeoutMs`.
   */
  withSignalHandlers(
    enabled: boolean = true,
    options: { shutdownTimeoutMs?: number } = {},
  ) {
    this.signalHandlersEnabled = enabled;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    return this;
  }

  /**
   * Registers an express router under a base path.
   * @param base Base path for this router.
   * @param router Router instance.
   * @param routes List of route definitions.
   */
  addRouter(
    base: string,
    router: Router,
    routes: AnyRouteDefinition[] = [],
  ) {
    addRouterRegistration(this.state, base, router, routes);
    return this;
  }

  /**
   * Gracefully shuts down the service: stops accepting HTTP requests, drains
   * workers, removes the registry entry, runs custom shutdown hooks, and
   * closes ClickHouse, MongoDB and Redis. Does not exit the process.
   *
   * Calling it more than once returns the same promise.
   */
  shutdown(opts: ShutdownOptions = {}): Promise<void> {
    this.shutdownPromise ??= this.stop(opts);
    return this.shutdownPromise;
  }

  private async stop(opts: ShutdownOptions) {
    this.removeSignalHandlers();
    await shutdownService(
      {
        dependencies: this.dependencies,
        log: this.state.log,
        name: this.name,
        setStatus: (status) => {
          this._status = status;
        },
        closeHttp: async () => {
          if (!this.server) return;
          await closeHttpServer(this.server);
          this.server = null;
        },
        stopWorkers: async () => {
          await this.workerPool?.stop();
        },
        stopHeartbeat: () => this.stopHeartbeat(),
        closeRedis: async () => {
          if (this.redis.isOpen) await this.redis.close();
        },
        disconnectMongo: () => this.mongo.disconnect(),
        closeClickhouse: () => this.clickhouse.client.close(),
      },
      opts,
    );
  }

  async [Symbol.asyncDispose]() {
    await this.shutdown();
  }

  *[Symbol.iterator]() {
    yield* this.dependencies.values();
  }
}
