import { pathToFileURL } from "url";
import { createClient, RedisClientType } from "redis";
import { parentPort, workerData } from "worker_threads";
import { ConsumerOptions, createStreamConsumer } from "./consumer";
import { RedisStreamEventHandler } from "./stream-handler";

export type WorkerThreadData = {
  name: string;
  redisUrl?: string;
  handlers: Record<string, string>;
  index: number;
  subscriptions: string[];
  config?: Record<string, unknown>;
  options?: ConsumerOptions;
};

export type WorkerThreadMessage =
  | { level: "info" | "warn" | "error"; message: string }
  | { level: "create"; message: string[] }
  | { level: "ready" };

const data = workerData as WorkerThreadData;

function post(msg: WorkerThreadMessage) {
  parentPort?.postMessage(msg);
}

const log = {
  info: (message: string) => post({ level: "info", message }),
  warn: (message: string) => post({ level: "warn", message }),
  error: (message: string) => post({ level: "error", message }),
};

function isHandler(value: unknown): value is RedisStreamEventHandler {
  const candidate = value as RedisStreamEventHandler | undefined;
  return (
    typeof candidate?.type === "string" &&
    typeof candidate?.execute === "function"
  );
}

async function loadHandlers(files: Record<string, string>) {
  const loaded = new Map<string, RedisStreamEventHandler>();

  for (const [name, filePath] of Object.entries(files)) {
    const mod = await import(pathToFileURL(filePath).href);
    if (!isHandler(mod.default)) {
      log.warn(
        `Handler file "${name}" has no default redisStreamHandler export. Skipping.`,
      );
      continue;
    }
    if (loaded.has(mod.default.type)) {
      log.warn(
        `Duplicate handler for event type "${mod.default.type}" in "${name}". Skipping.`,
      );
      continue;
    }
    loaded.set(mod.default.type, mod.default);
  }

  return loaded;
}

async function main() {
  const redis: RedisClientType = createClient({ url: data.redisUrl });
  redis.on("error", (err: Error) => log.error(`Redis error: ${err.message}`));
  await redis.connect();

  const handlers = await loadHandlers(data.handlers);
  post({ level: "create", message: [...handlers.keys()] });

  const consumer = createStreamConsumer({
    redis,
    service: data.name,
    index: data.index,
    subscriptions: data.subscriptions,
    handlers,
    log,
    config: data.config,
    options: data.options,
  });

  parentPort?.on("message", (msg: { type?: string }) => {
    if (msg?.type !== "stop") return;
    consumer
      .stop()
      .catch((err) => log.error(`Error while stopping: ${err}`))
      .finally(() => process.exit(0));
  });

  post({ level: "ready" });
  await consumer.start();
}

main().catch((err) => {
  log.error(`Worker ${data.index} failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
