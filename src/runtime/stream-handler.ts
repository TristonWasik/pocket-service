export type RedisStreamHandlerContext = {
  service: string;
  emit: (ev: {
    type: string;
    data: Record<string, string | number | boolean | null>;
  }) => Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};
export type RedisStreamEventHandler = {
  type: string;
  execute: (
    ev: Record<string, any>,
    ctx: RedisStreamHandlerContext,
  ) => Promise<void>;
};
export function redisStreamHandler(
  type: string,
  fn: RedisStreamEventHandler["execute"],
): RedisStreamEventHandler {
  return { type, execute: fn };
}
