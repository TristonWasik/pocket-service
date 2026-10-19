import type { RedisClientType } from "redis";
import type { EventData, EventDefinition, EventInput } from "./events";
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
  /**
   * Validates and publishes a typed event defined with `defineEvent()`.
   * Resolves with the new stream entry ID.
   */
  publish: <TEvent extends EventDefinition>(
    event: TEvent,
    data: EventInput<TEvent>,
  ) => Promise<string>;
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

/**
 * Minimal Zod-compatible parser, so the consumer does not depend on a
 * specific Zod instance.
 */
export type PayloadSchema = {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { message: string } };
};

export type RedisStreamEventHandler = {
  type: string;
  /** Present for typed handlers; the payload is validated before execute. */
  schema?: PayloadSchema;
  execute: (ev: any, ctx: RedisStreamHandlerContext) => Promise<void>;
};

/**
 * Handles a typed event. The payload is validated against the event's schema
 * before the handler runs; invalid payloads go straight to the DLQ.
 */
export function redisStreamHandler<TEvent extends EventDefinition>(
  event: TEvent,
  fn: (data: EventData<TEvent>, ctx: RedisStreamHandlerContext) => Promise<void>,
): RedisStreamEventHandler;
/**
 * Handles an untyped event, receiving the raw flat string fields.
 */
export function redisStreamHandler(
  type: string,
  fn: (ev: RedisStreamEvent, ctx: RedisStreamHandlerContext) => Promise<void>,
): RedisStreamEventHandler;
export function redisStreamHandler(
  typeOrEvent: string | EventDefinition,
  fn: (ev: any, ctx: RedisStreamHandlerContext) => Promise<void>,
): RedisStreamEventHandler {
  if (typeof typeOrEvent === "string") {
    return { type: typeOrEvent, execute: fn };
  }
  return { type: typeOrEvent.type, schema: typeOrEvent.schema, execute: fn };
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
