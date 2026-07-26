import { CustomModules } from "../types";

type Log = {
  info: (message: string) => void;
  error: (message: string) => void;
};

export type ServiceShutdownContext = {
  dependencies: Map<string, unknown>;
  quitRedis: () => Promise<unknown>;
  disconnectMongo: () => Promise<unknown>;
  closeClickhouse: () => Promise<unknown>;
  log: Log;
  name: string;
  setStatus: (status: "stopping" | "stopped") => void;
};

export async function shutdownService(
  ctx: ServiceShutdownContext,
  opts: {
    beforeShutdown?: () => Promise<void>;
    afterShutdown?: () => Promise<void>;
  } = {},
) {
  await opts.beforeShutdown?.();
  ctx.setStatus("stopping");

  if (ctx.dependencies.has("redis")) {
    await ctx.quitRedis();
  }
  if (ctx.dependencies.has("mongoClient")) {
    await ctx.disconnectMongo();
  }
  if (ctx.dependencies.has("clickhouse")) {
    await ctx.closeClickhouse();
  }
  if (ctx.dependencies.has("customDependencies")) {
    for (const dep of ctx.dependencies.get(
      "customDependencies",
    ) as CustomModules) {
      if (dep.shutdown) {
        try {
          const result = await dep.shutdown(ctx.log as any);
          ctx.log.info(
            `Custom dependency "${dep.name}" shutdown with result: ${result}`,
          );
        } catch (err) {
          ctx.log.error(
            `Failed to shutdown custom dependency "${dep.name}": ${err}`,
          );
        }
      }
    }
  }

  ctx.log.info(`Service ${ctx.name} shutting down.`);
  ctx.setStatus("stopped");
  await opts.afterShutdown?.();
  process.exit(0);
}
