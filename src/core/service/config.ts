import { Router } from "express";
import { createClient } from "redis";
import {
  AuthResolver,
  AuthStrategy,
  AnyRouteDefinition,
} from "../../api/express-types";
import {
  ClickhouseConfig,
  createTypedClickhouse,
} from "../../modules/clickhouse";
import { createMongo, MongoCollectionsConfig } from "../../modules/mongo/mongo";
import { CustomModules, ExpressOptions, Log } from "../types";
import type { OpenApiOptions } from "../../api/openapi";
import type { RateLimitOptions } from "../../api/rate-limit";
import type { WorkerDependency, WorkerOptions } from "./workers";

/**
 * Dependency map entries that are runtime objects rather than modules.
 */
export const INTERNAL_DEPENDENCIES = new Set([
  "logger",
  "expressApp",
  "customDependencies",
]);

export type RouterRegistration = {
  base: string;
  router: Router;
  routes?: AnyRouteDefinition[];
};

/**
 * Mutable configuration owned by a Service. The builder helpers below mutate
 * it in place.
 */
export type ServiceState = {
  dependencies: Map<string, unknown>;
  dependencyOrder: string[];
  log: Log;
  withoutExpressFlag: boolean;
  expressOptions: ExpressOptions;
  authStrategies: AuthStrategy[];
  authResolverOverride?: AuthResolver;
  useDefaultHeaderAuthFallback: boolean;
  serviceStreamSubscriptions: string[];
  workerCount: number;
  routers: RouterRegistration[];
  openApi?: OpenApiOptions;
  rateLimits?: RateLimitOptions;
};

export function addMongoDependency<
  TNextCollections extends MongoCollectionsConfig,
>(
  ctx: ServiceState,
  config: {
    dbName: string;
    uri?: string;
    collections: TNextCollections;
  },
) {
  if (!ctx.dependencies.has("mongoClient")) {
    const mongo = createMongo(config.dbName, config.collections, {
      uri: config.uri,
    });
    ctx.dependencies.set("mongoClient", mongo);
    ctx.dependencyOrder.push("mongoClient");
  }
}

export function addClickhouseDependency<TTables extends Record<string, any>>(
  ctx: ServiceState,
  config: ClickhouseConfig<TTables>,
) {
  if (!ctx.dependencies.has("clickhouse")) {
    ctx.dependencies.set("clickhouse", createTypedClickhouse(config));
    ctx.dependencyOrder.push("clickhouse");
  }
}

export function addRedisDependency(ctx: ServiceState, url: string) {
  if (!ctx.dependencies.has("redis")) {
    const client = createClient({ url });
    client.on("error", (err: Error) =>
      ctx.log.error(`Redis error: ${err.message}`),
    );
    ctx.dependencies.set("redis", client);
    ctx.dependencyOrder.push("redis");
  }
}

export function addWorkerDependency(
  ctx: ServiceState,
  workerCount: number,
  serviceStreams: string[] = [],
  options: WorkerOptions = {},
) {
  if (!ctx.dependencies.has("redis")) {
    ctx.log.warn(
      "Redis module not initialized. Call withRedis() before setting worker subscriptions.",
    );
    return;
  }

  if (!ctx.dependencies.has("workers") && serviceStreams.length > 0) {
    ctx.serviceStreamSubscriptions = serviceStreams;
    ctx.workerCount = workerCount < 1 ? 1 : workerCount;
    ctx.dependencies.set("workers", {
      workerCount: ctx.workerCount,
      subscriptions: serviceStreams,
      options,
    } satisfies WorkerDependency);
    ctx.dependencyOrder.push("workers");
  }
}

export function addCustomModules(ctx: ServiceState, modules: CustomModules) {
  if (!ctx.dependencies.has("customDependencies")) {
    ctx.dependencies.set(
      "customDependencies",
      modules.map((dep) => ({
        name: dep.name,
        init: dep.init,
        shutdown: dep.shutdown,
        ready: dep.ready,
      })),
    );
    ctx.dependencyOrder.push("customDependencies");
  }
}

export function disableExpress(ctx: ServiceState) {
  ctx.withoutExpressFlag = true;
}

export function setExpressOptions(
  ctx: ServiceState,
  options: Partial<ExpressOptions>,
) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn(
      "Express server is disabled. Express options will not be applied.",
    );
    return;
  }
  ctx.expressOptions = { ...ctx.expressOptions, ...options };
}

export function addAuthStrategy(ctx: ServiceState, strategy: AuthStrategy) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn(
      "Express server is disabled. Auth strategies will not be applied.",
    );
    return;
  }
  ctx.authStrategies.push(strategy);
}

export function addAuthStrategies(
  ctx: ServiceState,
  strategies: AuthStrategy[],
) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn(
      "Express server is disabled. Auth strategies will not be applied.",
    );
    return;
  }
  ctx.authStrategies.push(...strategies);
}

export function setAuthResolver(ctx: ServiceState, resolver: AuthResolver) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn(
      "Express server is disabled. Auth resolver will not be applied.",
    );
    return;
  }
  ctx.authResolverOverride = resolver;
}

export function disableDefaultHeaderAuthFallback(ctx: ServiceState) {
  ctx.useDefaultHeaderAuthFallback = false;
}

export function addRouterRegistration(
  ctx: ServiceState,
  base: string,
  router: Router,
  routes: AnyRouteDefinition[] = [],
) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn("Express server is disabled. Routers will not be registered.");
    return;
  }
  if (base === "/") {
    ctx.log.warn("Base path '/' is not allowed. Skipping.");
    return;
  }
  ctx.routers.push({ base, router, routes });
}
