import type { RedisClientType } from "redis";
import { streamForEventType } from "./stream-names";

/**
 * Fields of a stream entry as delivered to a handler. Every event carries an
 * `eventType` field; all other fields are flat strings.
 */
export type RedisStreamEvent = {
  eventType: string;
  [field: string]: string;
};

export type RedisStreamEmitInput = {
  type: string;
  data: Record<string, string | number | boolean | null>;
};

export type RedisStreamHandlerContext = {
  /** Name of the service running this handler. */
  service: string;
  /** Stream the event was read from. */
  stream: string;
  /** Stream entry ID of the event. */
  id: string;
  /**
   * Publishes an event to `<prefix>:events`, where prefix is the part of
   * `type` before the first `:`.
   */
  emit: (ev: RedisStreamEmitInput) => Promise<void>;
  /** The worker thread's own Redis connection. */
  redis: RedisClientType;
  /** Value passed as `config` to `withWorkers()`. */
  config: Record<string, unknown>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

export type RedisStreamEventHandler = {
  type: string;
  execute: (
    ev: RedisStreamEvent,
    ctx: RedisStreamHandlerContext,
  ) => Promise<void>;
};

export function redisStreamHandler(
  type: string,
  fn: RedisStreamEventHandler["execute"],
): RedisStreamEventHandler {
  return { type, execute: fn };
}

/**
 * Converts an emit input into the flat field map written to the stream.
 */
export function toStreamFields(ev: RedisStreamEmitInput) {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(ev.data)) {
    fields[key] = value === null ? "" : String(value);
  }
  fields.eventType = ev.type;
  return { stream: streamForEventType(ev.type), fields };
}
