/**
 * Shared naming for Redis stream consumers so the worker runtime and the
 * /workers API routes always agree on keys.
 */
export const groupName = (service: string) => `${service}:consumer-group`;

export const consumerName = (service: string, index: number) =>
  `${service}:worker-${index}`;

export const dlqStream = (stream: string) => `dlq:${stream}`;

/**
 * Event types are namespaced as `<service>:<event>` and are published to
 * `<service>:events`.
 */
export const streamForEventType = (eventType: string) =>
  `${eventType.split(":")[0]}:events`;
