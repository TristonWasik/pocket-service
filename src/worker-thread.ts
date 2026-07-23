import { createClient } from "redis";
import { parentPort, workerData } from "worker_threads";
import { RedisStreamEventHandler } from "./workers/stream-handler";

(async () => {
  const { name, redisUrl, handlers, index, subscriptions } = workerData as {
    name: string;
    redisUrl: string;
    handlers: Record<string, string>;
    index: number;
    subscriptions: string[];
  };
  const redis = createClient({ url: redisUrl });
  await redis.connect();

  parentPort?.postMessage({
    level: "info",
    message: `Connected to Redis at ${redisUrl}`,
  });

  const loadedHandlers = new Map();

  for (const [_, filePath] of Object.entries(handlers)) {
    const mod = await import(filePath);
    if (mod.default?.type && mod.default?.execute) {
      loadedHandlers.set(mod.default.type, mod.default);
    }
  }

  parentPort?.postMessage({
    level: "create",
    loadedHandlers: Object.keys(loadedHandlers),
  });

  const stream = `${name}:events`;
  const group = `${name}-group`;
  const consumer = `${name}-worker-${index}`;
  const dlqStream = `dlq:${stream}`;

  for (const streamName of subscriptions) {
    // TODO: infer from handlers
    try {
      await redis.xGroupCreate(streamName, group, "0", {
        MKSTREAM: true,
      });
    } catch (error) {
      if ((error as Error).message.includes("BUSYGROUP")) {
        parentPort?.postMessage({
          level: "warn",
          message: `Group ${group} already exists for stream ${streamName}, skipping creation`,
        });
      } else {
        parentPort?.postMessage({
          level: "error",
          message: `Error creating group: ${(error as Error).message}`,
        });
      }
    }
  }

  while (true) {
    const keys = subscriptions.map((s) => ({ key: s, id: ">" })); // TODO: infer from handlers
    const res = await redis.xReadGroup(group, consumer, keys, {
      COUNT: 10,
      BLOCK: 5000,
    });

    if (!res) {
      continue;
    }

    if (Array.isArray(res)) {
      for (const { name: streamName, messages } of res as {
        name: string;
        messages: {
          id: string;
          message: { eventType: string };
        }[];
      }[]) {
        for (const { id, message } of messages) {
          const eventType = message.eventType;
          const handler = loadedHandlers.get(
            eventType,
          ) as RedisStreamEventHandler;

          if (!handler) {
            parentPort?.postMessage({
              level: "error",
              message: `No handler found for event type: ${eventType}`,
            });
            await redis.xAck(stream, group, id);
            continue;
          }

          const timeoutMs = 3000;
          const maxRetries = 3;
          let attempts = 0;

          while (attempts < maxRetries) {
            attempts++;
            try {
              const result = await Promise.race([
                await handler.execute(message, {
                  emit: async (ev) => {
                    redis.xAdd(
                      `${ev.type.split(":")[0]}:events`,
                      "*",
                      ev as Record<string, any>,
                    );
                  },
                  log: {
                    info: (msg) =>
                      parentPort?.postMessage({ level: "info", message: msg }),
                    warn: (msg) =>
                      parentPort?.postMessage({ level: "warn", message: msg }),
                    error: (msg) =>
                      parentPort?.postMessage({ level: "error", message: msg }),
                  },
                  service: streamName,
                }),
                new Promise((resolve) =>
                  setTimeout(() => resolve("timeout"), timeoutMs),
                ),
              ]);

              if (result === "timeout") {
                throw new Error(
                  `Message processing timed out after ${timeoutMs}ms`,
                );
              }

              await redis.xAck(group, group, id);
              parentPort?.postMessage({
                level: "info",
                message: `Message ${id} processed successfully after ${attempts} attempts`,
              });
              return;
            } catch (error) {
              parentPort?.postMessage({
                level: "error",
                message: `Error processing message ${id}: ${
                  error instanceof Error ? error.message : error
                }`,
              });
              if (attempts === maxRetries) {
                await redis.xAdd(dlqStream, "*", {
                  originalId: id,
                  message: JSON.stringify(message),
                  error: error instanceof Error ? error.message : String(error),
                  timestamp: new Date().toISOString(),
                });
              }
            }
          }
        }
      }
    }
  }
})();
