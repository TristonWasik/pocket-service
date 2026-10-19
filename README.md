# Pocket Service

Pocket service is a wrapper for building easy, boilerplate-free TypeScript services.

Pocket service comes with the following built-in features:

- Express API with a few built-in endpoints
- Full type support via a builder pattern
- An optional Mongo module
- An optional ClickHouse module
- An optional Redis module
- An optional Redis worker module for consuming Redis streams
- A way to add your own modules/startup hooks that run during the build phase

## Public imports

Import from the package root only:

```ts
import { Service } from "@twasik4/pocket-service";
```

Deep imports into `src/*` or `dist/*` are not part of the public API surface.

## Service Class API

Use this as the quick reference, then jump to examples.

### Lifecycle

| Method | Description |
| ------ | ----------- |
| `await build()` | Connects every module, starts workers and the HTTP server, and resolves when the service is ready. Rejects (after cleaning up) if anything fails. See [Lifecycle and shutdown](#lifecycle-and-shutdown). |
| `await shutdown(opts?)` | Graceful shutdown. Doesn't exit the process. |
| `register()` / `heartbeat()` | Service registry in Redis. `build()` starts both automatically. |

### Builder methods (chainable)

| Method | Description |
| ------ | ----------- |
| `withName(name)` | Service name for logs and the registry ([Configurations](#configurations)) |
| `withPort(port?)` | HTTP port ([Configurations](#configurations)) |
| `withUrl(url)` | Base URL advertised in the registry ([Configurations](#configurations)) |
| `withRedis(url?)` | Redis client and service registration ([Modules](#modules)) |
| `withMongo(config)` | Typed Mongo collections ([Mongo Collection Helpers](#mongo-collection-helpers)) |
| `withClickhouse(config)` | Typed ClickHouse tables ([Example: withClickhouse](#example-withclickhouse)) |
| `withWorkers(count, streams?, options?)` | Redis stream workers ([Example: withWorkers](#example-withworkers)) |
| `withModules(modules)` | Custom startup and shutdown hooks ([Modules](#modules)) |
| `withExpressOptions(options)` | JSON parsing, CORS, middleware ([Example: withExpressOptions](#example-withexpressoptions)) |
| `withAuthStrategy(strategy)` / `withAuthStrategies(strategies)` | JWT, mTLS or custom auth ([Example](#example-withauthstrategies-jwt--mtls)) |
| `withAuthResolver(resolver)` | Fully custom auth ([Example: withAuthResolver](#example-withauthresolver)) |
| `withoutDefaultHeaderAuthFallback()` | Disable `x-user-id` header auth |
| `withoutExpress()` | No HTTP server (worker-only or module-only services) |
| `withSignalHandlers(enabled?, options?)` | SIGINT/SIGTERM handling ([Lifecycle and shutdown](#lifecycle-and-shutdown)) |
| `addRouter(base, router, routes?)` | Register a router ([Example: addRouter + createMetaRouter](#example-addrouter--createmetarouter)) |

### Public getters

`streamKey`, `simpleName`, `fullUrl`, `status`, `routes`, `api`, `log`, `redis`, `mongo`, `db`, `clickhouse`

### Symbols

- `[Symbol.asyncDispose]()` runs `shutdown()`, so `await using service = await new Service().build()` works.
- `[Symbol.iterator]()` yields the configured dependencies.

## Lifecycle and shutdown

`build()` is async. It resolves once the service is ready to serve traffic:

1. Configures Express middleware, CORS, the default routes and your routers.
2. Connects Redis, MongoDB and ClickHouse concurrently.
3. Runs custom module `init` hooks in order.
4. Starts workers, registers the service in Redis and starts the heartbeat.
5. Starts the HTTP server.

If any step fails, for example because Mongo is unreachable or the port is in use, everything that already started is shut down and `build()` rejects. Calling `build()` twice returns the same promise.

```ts
const service = await new Service()
  .withName("billing")
  .withRedis()
  .build();
```

`shutdown()` stops accepting HTTP requests, waits for in-flight requests and worker messages, removes the registry entry, runs custom `shutdown` hooks in reverse order, then closes ClickHouse, MongoDB and Redis. It **doesn't exit the process**, and calling it again returns the same promise.

By default, the service handles `SIGINT` and `SIGTERM` by running `shutdown()` and then exiting. If shutdown takes longer than `shutdownTimeoutMs` (default 15s), the process is forced to exit. A second `Ctrl+C` exits immediately.

```ts
// Change the timeout
new Service().withSignalHandlers(true, { shutdownTimeoutMs: 30_000 });

// Handle signals yourself
const service = await new Service().withSignalHandlers(false).build();
process.on("SIGTERM", async () => {
  await service.shutdown();
  process.exit(0);
});
```

In tests or scripts, `await using` shuts the service down when it goes out of scope:

```ts
await using service = await new Service().withPort(0).build();
```

## Environment variables

| Variable | Used for | Default |
| -------- | -------- | ------- |
| `SERVICE_NAME` | `withName()` | random hex string |
| `SERVICE_URL` | `withUrl()` | `http://localhost` |
| `SERVICE_PORT`, then `PORT` | `withPort()` | `3100` |
| `REDIS_URL` | `withRedis()` | `redis://redis:6379` |
| `MONGO_URI` | `withMongo()` when no `uri` is given | `mongodb://mongo:27017` |

Explicit builder arguments always win over environment variables.

## Examples

Use the Service class to streamline setup and reduce boilerplate.

### Example: Basic Service

```ts
const service = await new Service().build();
```

This includes an Express server with a few [built-in endpoints](#built-in-endpoints), plus a built-in Winston logger.

### Built-in Endpoints

Base routes:

| Method | Route   | Description                                |
| ------ | ------- | ------------------------------------------ |
| GET    | /       | OK Check                                   |
| GET    | /health | Used for health information on the service |

### Modules

1. withMongo()

A full MongoDB instance with a custom collection abstraction that offers full type support and auto-completion.

This also supports:

- Collection-level indexes
- Collection-level TTL without manually defining indexes
- Time-series collections (with granularity + retention support)
- Optional revision tracking for updates

2. withRedis()

A full Redis instance with built-in service registration.

3. withClickhouse()

Typed wrapper for table `select` and `insert`, plus custom methods with strongly typed inputs. `select()` only accepts columns from the table's `schema()`, and sends filter values as query parameters.

### Example: withClickhouse

```ts
const service = await new Service()
  .withClickhouse({
    url: "http://localhost:8123",
    username: "default",
    password: "",
    tables: {
      events: {
        name: "events",
        createSQL: `
          CREATE TABLE IF NOT EXISTS events (
            id String,
            type String,
            createdAt DateTime
          )
          ENGINE = MergeTree
          ORDER BY (createdAt, id)
        `,
        schema: () => ({
          id: "",
          type: "",
          createdAt: "",
        }),
      },
    },
  })
  .build();

await service.clickhouse.events.insert([
  { id: "evt_1", type: "user.created", createdAt: "2026-01-01 00:00:00" },
]);

const rows = await service.clickhouse.events.select({ type: "user.created" });
```

You can also define custom methods with strongly typed inputs. Use ClickHouse query parameters (`{name:Type}`); inputs are sent to the server as parameters and never interpolated into the SQL:

```ts
import { Service, defineClickhouseMethod } from "@twasik4/pocket-service";

const service = new Service().withClickhouse({
  url: "http://localhost:8123",
  tables: {
    events: {
      name: "events",
      createSQL: "CREATE TABLE IF NOT EXISTS events (...)",
      schema: () => ({ id: "", type: "", createdAt: "" }),
      methods: () => ({
        byType: defineClickhouseMethod<
          { type: string },
          Array<{ id: string; type: string; createdAt: string }>
        >({
          sql: "SELECT id, type, createdAt FROM events WHERE type = {type:String}",
        }),
      }),
    },
  },
});

const typedRows = await service.clickhouse.events.byType({
  type: "user.created",
});
```

4. withWorkers()

Consumes Redis streams in worker threads through a consumer group, with retries, a dead-letter queue (DLQ), and recovery of messages abandoned by crashed consumers.

### Example: withWorkers

`withWorkers` only initializes workers when at least one stream is passed in `serviceStreams`, and at least one handler file is found.

```ts
const service = await new Service()
  .withName("billing")
  .withRedis("redis://localhost:6379")
  .withWorkers(2, ["auth:events", "billing:events"], {
    handlersDir: "dist/handlers",
  })
  .build();
```

Each file in the handlers directory default-exports a `redisStreamHandler` (see [Example: withWorkers + redisStreamHandler](#example-withworkers--redisstreamhandler)). If `handlersDir` is not set, the service looks for `handlers/` next to your entry script, then `src/handlers`. `.js` and `.mjs` files work everywhere. `.ts` files need Node's built-in type stripping.

Workers run from the built package (`dist/runtime/worker-thread.mjs`).

#### When to use worker threads

Reading a stream with `XREADGROUP BLOCK` doesn't block the Node event loop; it only blocks its Redis connection. Worker threads add value when handlers are **CPU-heavy** and would otherwise stall your HTTP routes. Each worker runs in its own isolate with its own Redis connection, so handlers **can't** use this service's `db`, `mongo`, or `clickhouse` clients. Use `ctx.redis`, or pass connection details through `options.config` and create clients inside the handler module.

#### Message format and delivery

- Every stream entry has an `eventType` field, and every other field is a flat string. Handlers are dispatched by `eventType`.
- `ctx.emit({ type: "audit:user-created", data })` writes `{ eventType: type, ...data }` to `audit:events`. Values are converted to strings, and `null` becomes `""`.
- The consumer group is `<service name>:consumer-group`, so replicas of the same service share work, and different services each get every message.
- A failed handler is retried `maxRetries` times with exponential backoff. Each attempt is limited to `timeoutMs`. After the last failure the message is copied to `dlq:<stream>` and acknowledged.
- Messages left pending for longer than `claimIdleMs`, for example by a crashed worker, are reclaimed with `XAUTOCLAIM`.
- Messages with no matching handler are acknowledged and skipped.
- A crashed worker is restarted with backoff, up to `maxRestarts` times. `shutdown()` lets in-flight messages finish before workers exit.

| Option              | Default | Description                                  |
| ------------------- | ------- | -------------------------------------------- |
| `handlersDir`       | auto    | Directory of handler modules                 |
| `config`            | `{}`    | Passed to handlers as `ctx.config`           |
| `timeoutMs`         | 3000    | Max duration of one handler attempt          |
| `maxRetries`        | 3       | Attempts before a message goes to the DLQ    |
| `retryBackoffMs`    | 100     | Base retry delay, doubled each attempt       |
| `blockMs`           | 5000    | `XREADGROUP` block time                      |
| `batchSize`         | 10      | Messages per read                            |
| `claimIdleMs`       | 60000   | Idle time before a pending message is reclaimed |
| `claimIntervalMs`   | 30000   | How often to check for stale pending messages |
| `maxRestarts`       | 5       | Restarts per crashed worker                  |
| `shutdownTimeoutMs` | 10000   | Grace period before workers are terminated   |

Additional routes added to Express (all require auth). `:stream` must be one of the subscribed streams:

| Method | Route                          | Description                                              |
| ------ | ------------------------------ | -------------------------------------------------------- |
| GET    | /workers                       | Per-worker state, subscriptions, and loaded handlers     |
| GET    | /workers/:stream               | Most recent messages (`?count=`, max 100)                |
| GET    | /workers/:stream/pending       | Pending-entries summary for this service's group         |
| POST   | /workers/:stream/:id/ack       | Force acknowledge a message                              |
| GET    | /workers/:stream/dlq           | Most recent DLQ messages (`?count=`, max 100)            |
| POST   | /workers/:stream/dlq/:id/retry | Re-publish a DLQ message to its stream and remove it from the DLQ |

5. withModules(customModules: CustomModules)

Use this to register custom modules. Each `init` runs during `build()`, after Redis, Mongo and ClickHouse connect, in the order given. If `init` throws or returns `false`, `build()` rejects. Optional `shutdown` hooks run in reverse order during `shutdown()`:

```ts
const service = new Service().withModules([
  {
    name: "analytics",
    init: async (log) => {
      log.info("analytics init");
      return true;
    },
    shutdown: async (log) => {
      log.info("analytics shutdown");
      return true;
    },
  },
]);
```

### Configurations

1. withName()

Sets the service name, used primarily for service registration via Redis. Defaults to a random hex string.

```ts
const service = await new Service().withName("Service Name").build();
```

2. withPort()

Sets the port of the Express server. Defaults to 3100.

```ts
const service = await new Service().withPort(8111).build();
```

Setting the port as above makes Express listen on that port. Your root endpoint at http://localhost:8111/ returns:

```ts
OK from "Service Name" service
```

3. withUrl()

Sets the base URL of the service. Useful for service registration via Redis.

```ts
const service = await new Service().withUrl("https://my-domain.com").build();
```

4. withExpressOptions()

Manually configures Express options like CORS and custom middleware.

### Example: withExpressOptions

```ts
const service = await new Service()
  .withExpressOptions({
    asJson: true,
    corsWhitelist: ["http://localhost:5173"],
    credentials: true,
  })
  .build();
```

The snippet above parses incoming bodies with the Express JSON parser, enforces CORS, whitelists localhost on 5173, and passes credentials.

By default, `corsWhitelist` is `["*"]`, which allows requests from any origin. Combining `"*"` with `credentials: true` fails the build, because browsers reject that combination; list explicit origins instead.

You can also use `corsFn` instead of `corsWhitelist`, and `omitDefaultRoutes` if you do not want `/` and `/health`.

```ts
const service = await new Service()
  .withExpressOptions({
    asJson: true,
    omitDefaultRoutes: true,
    corsFn: (origin, cb) => {
      cb(null, origin === "http://localhost:5173");
    },
  })
  .build();
```

5. addRouter()

Registers a custom router with Express. This lets you add metadata and validation with Zod schemas.

### Example: addRouter + createMetaRouter

```ts
const { router, routes, addRoute } = createMetaRouter();

addRoute(
  {
    fullPath: "/login",
    method: "POST",
    requireAuth: false,
    bodyValidator: z.object({
      email: z.email(),
      password: z.string(),
    }),
    meta: {
      description: "Login endpoint",
    },
  },
  async (req, res) => {
    // contents here
    res
      .status(200)
      .json({ isSuccess: true, message: "Successfully logged in." });
  },
);

addRoute(
  {
    fullPath: "/register",
    method: "POST",
    requireAuth: false,
    bodyValidator: z.object({
      email: z.email(),
      password: z.string().min(6),
    }),
    meta: {
      description: "Register endpoint",
    },
  },
  async (req, res) => {
    // contents here
    res.status(200).json({ isSuccess: true, message: "Registered" });
  },
);

addRoute(
  {
    fullPath: "/logout",
    method: "POST",
    requireAuth: true,
    bodyValidator: z.object({
      refreshToken: z.string(),
    }),
    meta: {
      description: "Logout endpoint",
    },
  },
  async (req, res) => {
    // contents here
    res.status(200).json({ isSuccess: true, message: "Logged out" });
  },
);

addRoute(
  {
    fullPath: "/me",
    method: "GET",
    requireAuth: true,
    meta: {
      description: "Get current authenticated user info",
    },
  },
  async (req, res) => {
    // contents here
    res.status(200).json({ isSuccess: true, message: "Me" });
  },
);

addRoute(
  {
    fullPath: "/refresh",
    method: "POST",
    requireAuth: false,
    meta: {
      description: "Refresh token endpoint",
    },
  },
  async (req, res) => {
    // contents here
    res.json({ isSuccess: true, message: "Token refreshed" });
  },
);

export { router as AuthRouter, routes as AuthRoutes };
```

`createMetaRouter` also accepts optional auth hooks:

```ts
const { router, routes, addRoute } = createMetaRouter({
  authResolver: async (req, route) => {
    // custom auth logic
    return null;
  },
  onUnauthorized: (req, res) => {
    res.status(401).json({ isSuccess: false, message: "Unauthorized" });
  },
  onAuthError: (err, req, res) => {
    res.status(401).json({ isSuccess: false, message: "Unauthorized" });
  },
});
```

If no authResolver is provided, route auth falls back to the built-in header resolver (`x-user-id` / `x-user-meta`).

6. withAuthStrategy() / withAuthStrategies()

Use these hooks to plug in JWT, mTLS, or custom auth behavior while keeping route-level `requireAuth` unchanged.

### Example: withAuthStrategies (JWT + mTLS)

```ts
import {
  Service,
  createJoseJwtVerifier,
  createJwtAuthStrategy,
  createMtlsAuthStrategy,
} from "@twasik4/pocket-service";

const mtlsStrategy = createMtlsAuthStrategy({
  requireAuthorized: true,
});

const jwtStrategy = createJwtAuthStrategy({
  verifyToken: createJoseJwtVerifier({
    jwksUri: "http://auth-service:3101/.well-known/jwks.json",
    issuer: "auth-service",
    audience: "gateway-service",
  }),
});

const service = await new Service()
  .withAuthStrategies([mtlsStrategy, jwtStrategy])
  .withoutDefaultHeaderAuthFallback()
  .build();
```

If you use HMAC-signed tokens instead of JWKS:

```ts
import {
  Service,
  createJoseJwtVerifier,
  createJwtAuthStrategy,
} from "@twasik4/pocket-service";

const jwtStrategy = createJwtAuthStrategy({
  verifyToken: createJoseJwtVerifier({
    secret: process.env.INTERNAL_JWT_SECRET!,
    issuer: "auth-service",
    audience: "gateway-service",
    algorithms: ["HS256"],
  }),
});

const service = await new Service()
  .withAuthStrategy(jwtStrategy)
  .withoutDefaultHeaderAuthFallback()
  .build();
```

Default behavior remains backward compatible. If no strategy authenticates and fallback is enabled, the service still reads `x-user-id` / `x-user-meta` headers.

You can also customize strategy behavior further:

```ts
const jwtStrategy = createJwtAuthStrategy({
  headerName: "x-internal-auth",
  tokenPrefix: "Token",
  canHandle: async (req) => req.path.startsWith("/internal"),
  verifyToken: createJoseJwtVerifier({
    secret: process.env.INTERNAL_JWT_SECRET!,
    requiredClaims: ["sub", "scope"],
    clockTolerance: "30s",
    algorithms: ["HS256"],
  }),
  mapPayloadToUser: async (claims) => ({
    userId: String(claims.sub),
    scope: String(claims.scope || ""),
  }),
});

const mtlsStrategy = createMtlsAuthStrategy({
  requireAuthorized: true,
  canHandle: async (req) => req.path.startsWith("/internal"),
  mapCertificateToUser: async (cert) => ({
    userId: cert.fingerprint256 || "unknown",
  }),
});
```

7. withAuthResolver()

Use this when you want a fully custom auth resolver at the service level. This overrides strategy + fallback resolution.

### Example: withAuthResolver

```ts
const service = await new Service()
  .withAuthResolver(async (req, route) => {
    // fully custom auth
    return { userId: "internal-user" };
  })
  .build();
```

8. withoutDefaultHeaderAuthFallback()

Disables the built-in `x-user-id` / `x-user-meta` fallback when using auth strategies.

9. withoutExpress()

Builds the service without an Express server (useful for worker-only or module-only services).

### Mongo Collection Helpers

Mongo collections can be defined with options beyond schema:

```ts
import { defineMongoCollection } from "@twasik4/pocket-service";
import z from "zod";

const sessions = defineMongoCollection({
  schema: z.object({
    userId: z.string(),
    expiresAt: z.date(),
  }),
  ttl: {
    field: "expiresAt",
    expireAfterSeconds: 3600,
    name: "sessions_ttl",
  },
  indexes: [{ key: { userId: 1 }, name: "sessions_user_id" }],
});
```

You can also add custom collection methods using the `methods` callback:

```ts
const users = defineMongoCollection({
  schema: z.object({
    email: z.string(),
    status: z.string(),
  }),
  methods: ({ collection }) => ({
    async getActive() {
      return collection.find({ status: "active" }).toArray();
    },
  }),
});
```

If you want revision tracking, set `trackRevisions: true` on the collection config inside `withMongo`:

```ts
const service = new Service().withMongo({
  dbName: "app",
  collections: {
    accounts: {
      ...defineMongoCollection({
        schema: z.object({
          email: z.string(),
          revision: z.number().default(0),
        }),
      }),
      trackRevisions: true,
    },
  },
});
```

`deletedAt` enables soft-delete behavior. It does not automatically enable revision tracking.

For time-series collections:

```ts
const metrics = defineMongoCollection({
  schema: z.object({
    timestamp: z.date(),
    host: z.string(),
    value: z.number(),
  }),
  timeSeries: {
    timeField: "timestamp",
    metaField: "host",
    granularity: "seconds",
    expireAfterSeconds: 3600,
  },
});
```

### Utilities You Can Use

The package also exports:

- `redisStreamHandler()` to build strongly typed Redis stream handlers
- `groupName()`, `dlqStream()`, `streamForEventType()` stream naming helpers
- `createMetaRouter()` and route typing helpers
- Mongo helpers (`defineMongoCollection`, `createMongo`, `CollectionWrapper`)

Worker handler example:

### Example: withWorkers + redisStreamHandler

```ts
// src/handlers/user-created.ts
import { redisStreamHandler } from "@twasik4/pocket-service";

export default redisStreamHandler("auth:user-created", async (event, ctx) => {
  ctx.log.info(`${ctx.service} handling ${event.eventType} (${ctx.id})`);

  await ctx.emit({
    type: "audit:user-created",
    data: { userId: event.userId, ok: true },
  });
});
```

Producing an event from any service:

```ts
await service.redis.xAdd("auth:events", "*", {
  eventType: "auth:user-created",
  userId: "u_123",
});
```

## Migrating from 1.x

- **`build()` is async.** Change `new Service()...build()` to `await new Service()...build()`. It now rejects if a module fails to start; previously, errors were only logged.
- **`shutdown()` no longer calls `process.exit()`.** The built-in SIGINT/SIGTERM handlers still exit after shutting down. If you called `shutdown()` yourself and relied on it exiting, call `process.exit()` afterwards.
- **Custom modules:** `init` is awaited, and throwing or returning `false` fails `build()`. `shutdown` hooks run in reverse order.
- **`[Symbol.dispose]` was replaced by `[Symbol.asyncDispose]`.** Use `await using`.
- **ClickHouse custom methods use `{name:Type}` parameters instead of `:name`.** For example, `WHERE type = :type` becomes `WHERE type = {type:String}`. `select()` throws for columns that aren't in the table's `schema()`.
- **Mongo read methods throw on database errors.** `get`, `getOne`, `getRevisions` and `getMostRecentRevision` used to return `[]` or `null`.
- **CORS:** the default `corsWhitelist: ["*"]` now actually allows any origin. Combining `"*"` with `credentials: true` is rejected.
- **Workers:** the consumer group is now `<service name>:consumer-group`, and events use an `eventType` field. See [withWorkers](#example-withworkers).
- **Ports:** `SERVICE_PORT` now takes precedence over `PORT` everywhere.
- **Removed:** `getRegisteredRoutes()`, the `Message` type, and `RouteMeta.authRequired` (use `requireAuth`).

## Contributor layout

Current source layout:

1. `src/core` for `Service` orchestration and core helpers
2. `src/api` for Express route metadata/types helpers
3. `src/auth` for auth strategies
4. `src/modules` for Mongo/ClickHouse adapters
5. `src/runtime` for worker runtime and stream handling
