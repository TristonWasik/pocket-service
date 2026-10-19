import { setTimeout as sleep } from "timers/promises";
import type { RedisClientType } from "redis";
import {
  RedisStreamEvent,
  RedisStreamEventHandler,
  RedisStreamHandlerContext,
  toStreamFields,
} from "./stream-handler";
import { consumerName, dlqStream, groupName } from "./stream-names";

export type ConsumerOptions = {
  /** Max time a single handler attempt may take. Defaults to 3000ms. */
  timeoutMs?: number;
  /** Attempts per message before it is moved to the DLQ. Defaults to 3. */
  maxRetries?: number;
  /** Base delay between attempts, doubled each retry. Defaults to 100ms. */
  retryBackoffMs?: number;
  /** XREADGROUP BLOCK duration. Defaults to 5000ms. */
  blockMs?: number;
  /** Messages read per XREADGROUP / XAUTOCLAIM call. Defaults to 10. */
  batchSize?: number;
  /** Pending messages idle longer than this are reclaimed. Defaults to 60000ms. */
  claimIdleMs?: number;
  /** How often to look for stale pending messages. Defaults to 30000ms. */
  claimIntervalMs?: number;
};

type ConsumerLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type StreamConsumerConfig = {
  redis: RedisClientType;
  service: string;
  index: number;
  subscriptions: string[];
  handlers: Map<string, RedisStreamEventHandler>;
  log: ConsumerLog;
  config?: Record<string, unknown>;
  options?: ConsumerOptions;
};

const DEFAULT_OPTIONS: Required<ConsumerOptions> = {
  timeoutMs: 3000,
  maxRetries: 3,
  retryBackoffMs: 100,
  blockMs: 5000,
  batchSize: 10,
  claimIdleMs: 60_000,
  claimIntervalMs: 30_000,
};

const MAX_ERROR_BACKOFF_MS = 30_000;

type StreamReadReply = {
  name: string;
  messages: { id: string; message: Record<string, string> }[];
}[];

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Consumes Redis streams through a consumer group: reads new entries, retries
 * failed handlers with backoff, dead-letters exhausted messages, and reclaims
 * entries left pending by crashed consumers.
 */
export function createStreamConsumer(cfg: StreamConsumerConfig) {
  const opts = { ...DEFAULT_OPTIONS, ...cfg.options };
  const { redis, log, handlers, subscriptions } = cfg;
  const group = groupName(cfg.service);
  const consumer = consumerName(cfg.service, cfg.index);
  const abort = new AbortController();

  let stopping = false;
  let reading = false;
  let lastClaimAt = 0;
  let loop: Promise<void> | null = null;

  async function pause(ms: number) {
    try {
      await sleep(ms, undefined, { signal: abort.signal });
    } catch (err) {
      if (!isAbortError(err)) throw err;
    }
  }

  async function ensureGroups() {
    for (const stream of subscriptions) {
      try {
        await redis.xGroupCreate(stream, group, "0", { MKSTREAM: true });
      } catch (err) {
        if (!errorMessage(err).includes("BUSYGROUP")) throw err;
      }
    }
  }

  function buildContext(stream: string, id: string): RedisStreamHandlerContext {
    return {
      service: cfg.service,
      stream,
      id,
      redis,
      config: cfg.config ?? {},
      log,
      emit: async (ev) => {
        const { stream: target, fields } = toStreamFields(ev);
        await redis.xAdd(target, "*", fields);
      },
    };
  }

  async function runWithTimeout(run: () => Promise<void>) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Handler timed out after ${opts.timeoutMs}ms`)),
        opts.timeoutMs,
      );
    });
    try {
      await Promise.race([Promise.resolve().then(run), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function processMessage(
    stream: string,
    id: string,
    message: Record<string, string>,
  ) {
    const eventType = message.eventType;
    const handler = eventType ? handlers.get(eventType) : undefined;

    if (!handler) {
      log.warn(
        `No handler for event type "${eventType}" on ${stream} (${id}). Acknowledging.`,
      );
      await redis.xAck(stream, group, id);
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
      try {
        await runWithTimeout(() =>
          handler.execute(
            message as RedisStreamEvent,
            buildContext(stream, id),
          ),
        );
        await redis.xAck(stream, group, id);
        return;
      } catch (err) {
        lastError = err;
        log.error(
          `Attempt ${attempt}/${opts.maxRetries} failed for ${stream} ${id}: ${errorMessage(err)}`,
        );
        if (stopping) {
          // Leave the entry pending so it is retried after restart instead of
          // being dead-lettered early.
          return;
        }
        if (attempt < opts.maxRetries) {
          await pause(opts.retryBackoffMs * 2 ** (attempt - 1));
        }
      }
    }

    await redis.xAdd(dlqStream(stream), "*", {
      originalId: id,
      stream,
      eventType,
      message: JSON.stringify(message),
      error: errorMessage(lastError),
      attempts: String(opts.maxRetries),
      failedAt: new Date().toISOString(),
    });
    await redis.xAck(stream, group, id);
    log.error(`Moved ${stream} ${id} to ${dlqStream(stream)}`);
  }

  async function claimStale() {
    for (const stream of subscriptions) {
      let start = "0-0";
      do {
        const res = await redis.xAutoClaim(
          stream,
          group,
          consumer,
          opts.claimIdleMs,
          start,
          { COUNT: opts.batchSize },
        );
        for (const entry of res.messages) {
          if (!entry || stopping) continue;
          await processMessage(
            stream,
            entry.id,
            entry.message as Record<string, string>,
          );
        }
        start = res.nextId;
      } while (start !== "0-0" && !stopping);
    }
  }

  async function run() {
    let groupsReady = false;
    let failures = 0;

    while (!stopping) {
      try {
        if (!groupsReady) {
          await ensureGroups();
          groupsReady = true;
        }

        if (Date.now() - lastClaimAt >= opts.claimIntervalMs) {
          lastClaimAt = Date.now();
          await claimStale();
        }

        reading = true;
        const res = (await redis.xReadGroup(
          group,
          consumer,
          subscriptions.map((key) => ({ key, id: ">" })),
          { COUNT: opts.batchSize, BLOCK: opts.blockMs },
        )) as StreamReadReply | null;
        reading = false;
        failures = 0;

        for (const { name: stream, messages } of res ?? []) {
          for (const { id, message } of messages) {
            // Unprocessed entries stay pending and are reclaimed later.
            if (stopping) break;
            await processMessage(stream, id, message);
          }
        }
      } catch (err) {
        reading = false;
        if (stopping) break;
        if (errorMessage(err).includes("NOGROUP")) {
          // The stream or group was deleted; recreate it on the next pass.
          groupsReady = false;
        }
        failures++;
        const delay = Math.min(
          MAX_ERROR_BACKOFF_MS,
          500 * 2 ** (failures - 1),
        );
        log.error(`Consumer error, retrying in ${delay}ms: ${errorMessage(err)}`);
        await pause(delay);
      }
    }
  }

  return {
    start() {
      loop ??= run();
      return loop;
    },
    /**
     * Stops after the in-flight message finishes. A blocked XREADGROUP is
     * interrupted by destroying the connection; otherwise it is closed cleanly.
     */
    async stop() {
      stopping = true;
      abort.abort();
      if (reading) {
        redis.destroy();
      }
      await loop;
      if (redis.isOpen) {
        await redis.close();
      }
    },
  };
}
