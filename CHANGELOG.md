# Changelog

## 2.0.0 - 2026-10-19

### Breaking

- `build()` is async and resolves when the service is ready. It rejects, after shutting down whatever already started, if any module, custom `init` hook, or the HTTP listener fails.
- `shutdown()` no longer calls `process.exit()`. The built-in SIGINT/SIGTERM handlers exit after shutdown completes.
- Custom module `init` hooks are awaited in order, and returning `false` or throwing fails `build()`. `shutdown` hooks run in reverse order.
- `[Symbol.dispose]` was replaced by `[Symbol.asyncDispose]`, which supports `await using`.
- ClickHouse custom methods use native `{name:Type}` query parameters instead of `:name` placeholders.
- ClickHouse `select()` only accepts columns declared in the table's `schema()`.
- Mongo `get`, `getOne`, `getRevisions` and `getMostRecentRevision` throw on database errors instead of returning `[]` or `null`.
- Combining `corsWhitelist: ["*"]` with `credentials: true` is rejected.
- `SERVICE_PORT` takes precedence over `PORT` in both the default port and `withPort()`.
- Removed `getRegisteredRoutes()`, the `Message` type, and `RouteMeta.authRequired`.
- The package only exposes `exports`. `main` and `types` were removed.

### Added

- `withSignalHandlers(enabled, { shutdownTimeoutMs })` to configure or disable SIGINT/SIGTERM handling. SIGTERM is now handled, not just SIGINT.
- `withRedis()` defaults to the `REDIS_URL` environment variable.
- `pnpm typecheck` script, and a typecheck step in CI.

### Fixed

- Modules were logged as "initialized successfully" before they connected, and under the wrong names. `build()` also reported `running` immediately.
- `shutdown()` now closes the HTTP server, stops the heartbeat, and removes the service's registry key.
- Shutdown continues past a failing step instead of leaving later dependencies open.
- ClickHouse `select()` interpolated raw filter values into SQL, and custom methods used escaping that missed backslashes. Both now use server-side query parameters.
- The default CORS config (`["*"]`) matched no real origin, so no CORS headers were sent.
- The registry entry listed no dependencies, because the code called `Object.keys` on a Map.
- `[Symbol.iterator]` yielded nothing.
- Heartbeat failures caused unhandled promise rejections.

### Changed

- `Service` keeps its configuration in a single state object, replacing the config sync layer.
- ClickHouse uses the `url` client option instead of the deprecated `host`.
- Removed the unused `winston-transport` dependency.

## 1.2 - 2026-10-18

### Fixed

- Worker threads now start when the package is installed from npm.
- Workers no longer exit after processing their first message.
- Messages are acknowledged on the stream they were read from.
- `ctx.emit` is awaited and writes flat string fields with `eventType`, so other services can consume emitted events.
- Dead-lettered messages are acknowledged, retries back off exponentially, and messages abandoned by crashed consumers are reclaimed with `XAUTOCLAIM`.
- Redis errors in a worker are retried with backoff instead of killing the thread, and crashed workers are restarted.
- `/workers` routes now use the `:stream` parameter, the real DLQ stream (`dlq:<stream>`) and the same consumer group as the workers. DLQ retry re-publishes the original message and removes it from the DLQ.
- The main Redis client has an `error` listener, so a dropped connection no longer crashes the process.

### Added

- `withWorkers(count, streams, options)` with `handlersDir`, `config`, and timeout, retry, claim, and restart tuning.
- `GET /workers/:stream/pending`, and per-worker state on `GET /workers`.
- Handler context fields `stream`, `id`, `redis`, and `config`.
- Stream naming helpers `groupName`, `consumerName`, `dlqStream`, `streamForEventType`.
- `shutdown()` drains and stops worker threads before closing Redis.

### Changed

- The consumer group is now `<service name>:consumer-group`, and `ctx.service` is now the service name instead of the stream.
- `/workers` stream routes only accept subscribed streams, and return 404 for any other stream.
- Workers are not started when no handler files are found. Previously every message would have been acknowledged and dropped.
- CI starts a Redis service and builds before running tests.

## 1.1.1 - 2026-07-27

### Changed

- Updated runtime and tooling constraints:
  - node engines requirement to >=24
  - packageManager pin to pnpm@11.17.0
- Hardened GitHub workflows for modern pnpm/Corepack behavior:
  - disabled interactive Corepack download prompts in CI/publish workflows
  - ensured workflows continue using pinned v7 action commit SHAs
- Improved CI reliability for integration tests by setting a workspace-local MongoDB binary cache path in workflow test steps.

### Fixed

- Fixed pnpm workspace build policy configuration by setting valid allowBuilds booleans for esbuild and mongodb-memory-server.

## 1.1.0 - 2026-07-26

### Added

- Added expanded unit coverage for split service helpers:
  - api helper tests
  - config helper tests
  - lifecycle helper tests
  - shutdown helper tests
  - workers helper tests
- Added integration coverage for worker route auth behavior:
  - default header fallback enabled path
  - default header fallback disabled path
- Added publish safeguards in package scripts:
  - prepublishOnly
  - pack:check

### Changed

- Refactored internal service helper layout under src/core/service for clearer separation of concerns.
- Restructured tests into tests/unit and tests/integration.
- Tightened package metadata and publish surface:
  - corrected ESM entry/type paths to dist output
  - restricted published files to dist, README, and LICENSE
  - added repository/bugs/homepage/keywords/engines metadata
  - set scoped package publish access to public
- Improved worker thread entry resolution in service workers runtime.

### Notes

- Public import surface remains package-root based:
  - import from @twasik4/pocket-service
