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

## Service Class API

Use this as the quick reference, then jump to examples.

### Lifecycle and runtime

1. `build()` -> [Example: Basic Service](#example-basic-service)
2. `register()` -> [Modules](#modules)
3. `heartbeat()` -> [Modules](#modules)
4. `shutdown(opts?)` -> [Modules](#modules)

### Builder methods (chainable)

1. `withName(name)` -> [Configurations](#configurations)
2. `withPort(port?)` -> [Configurations](#configurations)
3. `withUrl(url)` -> [Configurations](#configurations)
4. `withRedis(url?)` -> [Modules](#modules)
5. `withMongo(config)` -> [Mongo Collection Helpers](#mongo-collection-helpers)
6. `withClickhouse(config)` -> [Modules](#modules)
7. `withWorkers(workerCount, serviceStreams?)` -> [Example: withWorkers](#example-withworkers)
8. `withModules(customModules)` -> [Modules](#modules)
9. `withExpressOptions(options)` -> [Example: withExpressOptions](#example-withexpressoptions)
10. `withAuthStrategy(strategy)` -> [Example: withAuthStrategies (JWT + mTLS)](#example-withauthstrategies-jwt--mtls)
11. `withAuthStrategies(strategies)` -> [Example: withAuthStrategies (JWT + mTLS)](#example-withauthstrategies-jwt--mtls)
12. `withAuthResolver(resolver)` -> [Example: withAuthResolver](#example-withauthresolver)
13. `withoutDefaultHeaderAuthFallback()` -> [Example: withAuthStrategies (JWT + mTLS)](#example-withauthstrategies-jwt--mtls)
14. `withoutExpress()` -> [Configurations](#configurations)
15. `addRouter(base, router, routes?)` -> [Example: addRouter + createMetaRouter](#example-addrouter--createmetarouter)

### Public getters

1. `streamKey`
2. `simpleName`
3. `fullUrl`
4. `status`
5. `routes`
6. `api`
7. `log`
8. `redis`
9. `mongo`
10. `db`
11. `clickhouse`

### Advanced public symbols

1. `[Symbol.dispose]()`
2. `[Symbol.iterator]()`

## Examples

Use the Service class to streamline setup and reduce boilerplate.

### Example: Basic Service

```ts
const service = new Service().build();
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

Typed wrapper for table `select` and `insert`, plus custom methods with strongly typed inputs.

### Example: withClickhouse

```ts
const service = new Service()
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

You can also define custom methods with named inputs (`:inputName`) and strong typing:

```ts
import { Service, defineClickhouseMethod } from "pocket-service";

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
          sql: "SELECT id, type, createdAt FROM events WHERE type = :type",
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

Adds built-in workers to consume Redis streams off the main loop.

### Example: withWorkers

`withWorkers` only initializes workers when at least one stream is passed in `serviceStreams`.

```ts
const service = new Service()
  .withRedis("redis://localhost:6379")
  .withWorkers(2, ["auth:events", "billing:events"])
  .build();
```

If `serviceStreams` is empty, workers are not initialized.

Worker files are loaded from `src/handlers`.

Additional routes added to Express:

| Method | Route                          | Description                                          |
| ------ | ------------------------------ | ---------------------------------------------------- |
| GET    | /workers                       | Used for worker health information                   |
| GET    | /workers/:stream               | Gets all messages from this service's stream         |
| POST   | /workers/:stream/:id/ack       | Force acknowledge a message in this service's stream |
| GET    | /workers/:stream/dlq           | Gets all messages from this service's DLQ stream     |
| POST   | /workers/:stream/dlq/:id/retry | Force retries a message in this service's DLQ stream |

5. withModules(customModules: CustomModules)

Use this to register custom modules.

You can also add optional `shutdown` hooks:

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
const service = new Service().withName("Service Name").build();
```

2. withPort()

Sets the port of the Express server. Defaults to 3100.

```ts
const service = new Service().withPort(8111).build();
```

Setting the port as above makes Express listen on that port. Your root endpoint at http://localhost:8111/ returns:

```ts
OK from "Service Name" service
```

3. withUrl()

Sets the base URL of the service. Useful for service registration via Redis.

```ts
const service = new Service().withUrl("https://my-domain.com").build();
```

4. withExpressOptions()

Manually configures Express options like CORS and custom middleware.

### Example: withExpressOptions

```ts
const service = new Service()
  .withExpressOptions({
    asJson: true,
    corsWhitelist: ["http://localhost:5173"],
    credentials: true,
  })
  .build();
```

The snippet above parses incoming bodies with the Express JSON parser, enforces CORS, whitelists localhost on 5173, and passes credentials.

You can also use `corsFn` instead of `corsWhitelist`, and `omitDefaultRoutes` if you do not want `/` and `/health`.

```ts
const service = new Service()
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
      description: "Register endpoint",
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

const service = new Service()
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

const service = new Service()
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
const service = new Service()
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
- `createMetaRouter()` and route typing helpers
- Mongo helpers (`defineMongoCollection`, `createMongo`, `CollectionWrapper`)

Worker handler example:

### Example: withWorkers + redisStreamHandler

```ts
import { redisStreamHandler } from "@twasik4/pocket-service";

export default redisStreamHandler("user:created", async (event, ctx) => {
  ctx.log.info(`Handling event for service ${ctx.service}`);

  await ctx.emit({
    type: "audit:user-created",
    data: {
      userId: String(event.userId || ""),
      ok: "true",
    },
  });
});
```
