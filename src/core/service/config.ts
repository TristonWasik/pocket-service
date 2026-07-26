import { Router } from "express";
import { createClient } from "redis";
import {
  AuthResolver,
  AuthStrategy,
  RouteDefinition,
} from "../../api/express-types";
import {
  ClickhouseConfig,
  createTypedClickhouse,
} from "../../modules/clickhouse";
import { createMongo, MongoCollectionsConfig } from "../../modules/mongo/mongo";
import { CustomModules, ExpressOptions } from "../types";

type Log = {
  warn: (message: string) => void;
};

export type ServiceConfigContext = {
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
  routers: {
    base: string;
    router: Router;
    routes?: RouteDefinition<any, any, boolean>[];
  }[];
};

export function addMongoDependency<
  TNextCollections extends MongoCollectionsConfig,
>(
  ctx: ServiceConfigContext,
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
  ctx: ServiceConfigContext,
  config: ClickhouseConfig<TTables>,
) {
  if (!ctx.dependencies.has("clickhouse")) {
    ctx.dependencies.set("clickhouse", createTypedClickhouse(config));
    ctx.dependencyOrder.push("clickhouse");
  }
}

export function addRedisDependency(
  ctx: ServiceConfigContext,
  url: string = "redis://redis:6379",
) {
  if (!ctx.dependencies.has("redis")) {
    ctx.dependencies.set("redis", createClient({ url }));
    ctx.dependencyOrder.push("redis");
  }
}

export function addWorkerDependency(
  ctx: ServiceConfigContext,
  workerCount: number,
  serviceStreams: string[] = [],
) {
  if (!ctx.dependencies.has("redis")) {
    ctx.log.warn(
      "Redis module not initialized. Call withRedis() before setting worker subscriptions.",
    );
    return;
  }

  if (!ctx.dependencies.has("workers") && serviceStreams.length > 0) {
    ctx.dependencies.set("workers", true);
    ctx.serviceStreamSubscriptions = serviceStreams;
    ctx.workerCount = workerCount < 1 ? 1 : workerCount;
    ctx.dependencyOrder.push("workers");
  }
}

export function addCustomModules(
  ctx: ServiceConfigContext,
  modules: CustomModules,
) {
  if (!ctx.dependencies.has("customDependencies")) {
    ctx.dependencies.set(
      "customDependencies",
      modules.map((dep) => ({
        name: dep.name,
        init: dep.init,
        shutdown: dep.shutdown,
      })),
    );
    ctx.dependencyOrder.push("customDependencies");
  }
}

export function disableExpress(ctx: ServiceConfigContext) {
  ctx.withoutExpressFlag = true;
}

export function setExpressOptions(
  ctx: ServiceConfigContext,
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

export function addAuthStrategy(
  ctx: ServiceConfigContext,
  strategy: AuthStrategy,
) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn(
      "Express server is disabled. Auth strategies will not be applied.",
    );
    return;
  }
  ctx.authStrategies.push(strategy);
}

export function addAuthStrategies(
  ctx: ServiceConfigContext,
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

export function setAuthResolver(
  ctx: ServiceConfigContext,
  resolver: AuthResolver,
) {
  if (ctx.withoutExpressFlag) {
    ctx.log.warn(
      "Express server is disabled. Auth resolver will not be applied.",
    );
    return;
  }
  ctx.authResolverOverride = resolver;
}

export function disableDefaultHeaderAuthFallback(ctx: ServiceConfigContext) {
  ctx.useDefaultHeaderAuthFallback = false;
}

export function addRouterRegistration(
  ctx: ServiceConfigContext,
  base: string,
  router: Router,
  routes: RouteDefinition<any, any, boolean>[] = [],
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
