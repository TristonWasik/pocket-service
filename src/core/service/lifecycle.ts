import { Logger } from "winston";
import { CustomModules, Log } from "../types";

export type ServiceLifecycleContext = {
  dependencies: Map<string, unknown>;
  log: Log;
  connectRedis: () => Promise<unknown>;
  connectMongo: () => Promise<unknown>;
  ensureClickhouseTables: () => Promise<unknown>;
  startWorkers: () => void;
  register: () => Promise<void>;
  startHeartbeat: () => void;
  startHttp: () => Promise<void>;
};

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Starts every configured dependency and resolves once the service is ready.
 * Throws on the first failure; the caller is responsible for tearing down
 * whatever already started.
 *
 * Order: core modules (concurrently) -> custom modules (in order) -> workers
 * -> registry + heartbeat -> HTTP server.
 */
export async function startService(ctx: ServiceLifecycleContext) {
  const core: [string, () => Promise<unknown>][] = [];
  if (ctx.dependencies.has("redis")) core.push(["redis", ctx.connectRedis]);
  if (ctx.dependencies.has("mongoClient")) {
    core.push(["mongoClient", ctx.connectMongo]);
  }
  if (ctx.dependencies.has("clickhouse")) {
    core.push(["clickhouse", ctx.ensureClickhouseTables]);
  }

  const results = await Promise.allSettled(
    core.map(async ([name, start]) => {
      try {
        await start();
      } catch (err) {
        throw new Error(
          `Failed to initialize module "${name}": ${errorMessage(err)}`,
          { cause: err },
        );
      }
      ctx.log.info(`Module "${name}" initialized.`);
    }),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure) {
    throw failure.reason;
  }

  const customModules =
    (ctx.dependencies.get("customDependencies") as CustomModules | undefined) ??
    [];
  for (const module of customModules) {
    let ok: boolean;
    try {
      ok = await module.init(ctx.log as Logger);
    } catch (err) {
      throw new Error(
        `Failed to initialize custom module "${module.name}": ${errorMessage(err)}`,
        { cause: err },
      );
    }
    if (ok === false) {
      throw new Error(`Custom module "${module.name}" init returned false.`);
    }
    ctx.log.info(`Custom module "${module.name}" initialized.`);
  }

  if (ctx.dependencies.has("workers")) {
    ctx.startWorkers();
  }

  if (ctx.dependencies.has("redis")) {
    await ctx.register();
    ctx.startHeartbeat();
    ctx.log.info("Service registered in Redis.");
  }

  await ctx.startHttp();
}
