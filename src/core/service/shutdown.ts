import { Logger } from "winston";
import { CustomModules, Log, ServiceStatus } from "../types";

export type ServiceShutdownContext = {
  dependencies: Map<string, unknown>;
  log: Log;
  name: string;
  setStatus: (status: Extract<ServiceStatus, "stopping" | "stopped">) => void;
  closeHttp: () => Promise<void>;
  stopWorkers: () => Promise<void>;
  stopHeartbeat: () => Promise<void>;
  closeRedis: () => Promise<unknown>;
  disconnectMongo: () => Promise<unknown>;
  closeClickhouse: () => Promise<unknown>;
};

export type ShutdownOptions = {
  /**
   * Runs before anything is stopped.
   */
  beforeShutdown?: () => Promise<void>;
  /**
   * Runs after every dependency has been closed.
   */
  afterShutdown?: () => Promise<void>;
};

/**
 * Stops the service in reverse order of startup. Each step is attempted even
 * if an earlier one fails, so a single broken dependency cannot leave the
 * others open. Does not exit the process.
 */
export async function shutdownService(
  ctx: ServiceShutdownContext,
  opts: ShutdownOptions = {},
) {
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      ctx.log.error(`Shutdown step "${name}" failed: ${err}`);
    }
  };

  await opts.beforeShutdown?.();
  ctx.setStatus("stopping");

  await step("http", ctx.closeHttp);
  await step("workers", ctx.stopWorkers);
  await step("registry", ctx.stopHeartbeat);

  const customModules =
    (ctx.dependencies.get("customDependencies") as CustomModules | undefined) ??
    [];
  for (const dep of [...customModules].reverse()) {
    if (!dep.shutdown) continue;
    await step(`custom:${dep.name}`, async () => {
      const result = await dep.shutdown!(ctx.log as Logger);
      ctx.log.info(
        `Custom dependency "${dep.name}" shutdown with result: ${result}`,
      );
    });
  }

  if (ctx.dependencies.has("clickhouse")) {
    await step("clickhouse", ctx.closeClickhouse);
  }
  if (ctx.dependencies.has("mongoClient")) {
    await step("mongoClient", ctx.disconnectMongo);
  }
  if (ctx.dependencies.has("redis")) {
    await step("redis", ctx.closeRedis);
  }

  ctx.setStatus("stopped");
  ctx.log.info(`Service ${ctx.name} stopped.`);
  await opts.afterShutdown?.();
}
