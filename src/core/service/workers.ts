import { existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Worker } from "worker_threads";

type Log = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type ServiceWorkerContext = {
  name: string;
  dependencies: Map<string, unknown>;
  log: Log;
  handlers: Record<string, string>;
  redis: {
    options?: {
      url?: string;
    };
  };
  workerCount: number;
  serviceStreamSubscriptions: string[];
  isWorkerRunning: boolean;
  loadedEventListeners: string[];
};

export function loadHandlers(ctx: ServiceWorkerContext) {
  if (!ctx.dependencies.has("redis")) {
    ctx.log.warn("Redis module not initialized. Skipping handler loading.");
    return;
  }

  const handlersDir = path.resolve(process.cwd(), "src/handlers");
  if (!existsSync(handlersDir)) {
    ctx.log.warn("Handlers directory does not exist.");
    return;
  }

  const files = readdirSync(handlersDir).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );

  for (const file of files) {
    const modulePath = path.join(handlersDir, file);
    ctx.handlers[path.basename(file, path.extname(file))] = modulePath;
  }

  ctx.log.info(`Loaded ${Object.keys(ctx.handlers).length} handlers:`);
  for (const handlerName of Object.keys(ctx.handlers)) {
    ctx.log.info(`- ${handlerName}`);
  }
}

export function runWorkers(
  ctx: ServiceWorkerContext,
  { workerCount }: { workerCount: number } = { workerCount: 1 },
) {
  if (!ctx.name) {
    ctx.log.error("Service name is not set. Cannot start workers.");
    return;
  }

  if (!ctx.dependencies.has("redis")) {
    ctx.log.warn("Redis module not initialized. Skipping worker setup.");
    return;
  }

  if (isNaN(workerCount) || workerCount < 1) {
    throw new Error("Worker count must be a number greater than 0.");
  }

  const workerEntry = resolveWorkerThreadEntryUrl();
  if (!workerEntry) {
    ctx.log.warn("Worker thread entry file not found. Skipping worker setup.");
    return;
  }

  ctx.workerCount = workerCount < 1 ? 1 : workerCount;

  for (let i = 0; i < workerCount; i++) {
    const workerThread = new Worker(workerEntry, {
      workerData: {
        name: ctx.name,
        redisUrl: ctx.redis.options?.url,
        handlers: ctx.handlers,
        index: i,
        subscriptions: ctx.serviceStreamSubscriptions ?? [`${ctx.name}:events`],
      },
    });

    ctx.isWorkerRunning = true;

    workerThread.on("error", (err) => {
      ctx.log.error(`Worker ${i} error: ${err.message}`);
    });

    workerThread.on("message", (msg) => {
      switch (msg.level) {
        case "info":
          ctx.log.info(msg.message);
          break;
        case "warn":
          ctx.log.warn(msg.message);
          break;
        case "error":
          ctx.log.error(msg.message);
          break;
        case "create":
          ctx.loadedEventListeners = msg.message;
          break;
        default:
          ctx.log.info(msg.message);
      }
    });

    workerThread.on("exit", (code) => {
      if (code !== 0) {
        ctx.log.error(`Worker ${i} stopped with exit code ${code}`);
      } else {
        ctx.log.info(`Worker ${i} exited gracefully.`);
      }
      ctx.isWorkerRunning = false;
    });

    ctx.log.info(`Worker ${i} started for service ${ctx.name}`);
  }
}

function resolveWorkerThreadEntryUrl(): URL | null {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(sourceDir, "../../runtime/worker-thread.js"),
    path.resolve(sourceDir, "../../runtime/worker-thread.mjs"),
    path.resolve(process.cwd(), "dist/runtime/worker-thread.mjs"),
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  return match ? pathToFileURL(match) : null;
}
