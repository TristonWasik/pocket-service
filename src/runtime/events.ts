import z, { input, output, ZodType } from "zod";
import { streamForEventType } from "./stream-names";

/**
 * A named event with a Zod schema for its payload. Published to
 * `<prefix>:events`, where prefix is the part of `type` before the first `:`.
 */
export type EventDefinition<
  TType extends string = string,
  TSchema extends ZodType = ZodType,
> = {
  readonly type: TType;
  readonly schema: TSchema;
  readonly stream: string;
};

/** What a publisher passes for an event (the schema's input type). */
export type EventInput<TEvent extends EventDefinition> = input<
  TEvent["schema"]
>;

/** What a handler receives for an event (the schema's output type). */
export type EventData<TEvent extends EventDefinition> = output<
  TEvent["schema"]
>;

/**
 * Defines a typed event. Share the definition between the publishing and the
 * consuming service so both agree on the payload.
 *
 * Payloads are sent as JSON, so use `z.coerce.date()` rather than `z.date()`
 * for dates.
 *
 * @example
 * export const UserCreated = defineEvent(
 *   "auth:user-created",
 *   z.object({ userId: z.string(), plan: z.enum(["free", "pro"]) }),
 * );
 */
export function defineEvent<TType extends string, TSchema extends ZodType>(
  type: TType,
  schema: TSchema,
): EventDefinition<TType, TSchema> {
  return { type, schema, stream: streamForEventType(type) };
}

/**
 * Validates a payload and returns the stream and fields to write. The fields
 * are `{ eventType, payload }`, with the payload JSON-encoded so numbers,
 * booleans and nested values keep their types.
 */
export function encodeEvent<TEvent extends EventDefinition>(
  event: TEvent,
  data: EventInput<TEvent>,
) {
  const result = event.schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Invalid payload for event "${event.type}":\n${z.prettifyError(result.error)}`,
    );
  }
  return {
    stream: event.stream,
    fields: { eventType: event.type, payload: JSON.stringify(data) },
  };
}
