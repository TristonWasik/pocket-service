/// <reference types="vitest/globals" />
import { randomBytes } from "crypto";
import { createClient, RedisClientType } from "redis";
import z from "zod";
import { defineEvent, encodeEvent } from "../../src/runtime/events";
import { createStreamConsumer } from "../../src/runtime/consumer";
import {
  redisStreamHandler,
  RedisStreamEventHandler,
} from "../../src/runtime/stream-handler";
import { dlqStream, groupName } from "../../src/runtime/stream-names";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Redis stream consumer", () => {
  let admin: RedisClientType;
  let prefix: string;
  let stream: string;
  const service = "consumer-test";
  const consumers: { stop: () => Promise<void> }[] = [];

  async function startConsumer(
    handlers: RedisStreamEventHandler[],
    options = {},
    index = 0,
  ) {
    const redis: RedisClientType = createClient({ url: REDIS_URL });
    await redis.connect();
    const consumer = createStreamConsumer({
      redis,
      service,
      index,
      subscriptions: [stream],
      handlers: new Map(handlers.map((h) => [h.type, h])),
      log: silentLog,
      options: { blockMs: 100, retryBackoffMs: 1, ...options },
    });
    void consumer.start();
    consumers.push(consumer);
    return consumer;
  }

  beforeAll(async () => {
    admin = createClient({ url: REDIS_URL });
    await admin.connect();
  });

  beforeEach(() => {
    prefix = `t${randomBytes(4).toString("hex")}`;
    stream = `${prefix}:events`;
  });

  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.stop()));
    await admin.del([stream, dlqStream(stream), `${prefix}out:events`]);
  });

  afterAll(async () => {
    await admin.close();
  });

  it("handles every message and leaves nothing pending", async () => {
    const seen: string[] = [];
    await startConsumer([
      redisStreamHandler(`${prefix}:ping`, async (ev) => {
        seen.push(ev.n);
      }),
    ]);

    for (let n = 0; n < 50; n++) {
      await admin.xAdd(stream, "*", { eventType: `${prefix}:ping`, n: String(n) });
    }

    await waitFor(async () => seen.length === 50);
    const pending = await admin.xPending(stream, groupName(service));
    expect(pending.pending).toBe(0);
  });

  it("dead-letters a message after maxRetries and acknowledges it", async () => {
    let attempts = 0;
    await startConsumer(
      [
        redisStreamHandler(`${prefix}:bad`, async () => {
          attempts++;
          throw new Error("nope");
        }),
      ],
      { maxRetries: 3 },
    );

    const id = await admin.xAdd(stream, "*", { eventType: `${prefix}:bad` });

    await waitFor(async () => (await admin.xLen(dlqStream(stream))) === 1);
    const [entry] = await admin.xRange(dlqStream(stream), "-", "+");
    expect(attempts).toBe(3);
    expect(entry.message).toMatchObject({ originalId: id, error: "nope" });
    expect((await admin.xPending(stream, groupName(service))).pending).toBe(0);
  });

  it("times out slow handlers", async () => {
    await startConsumer(
      [
        redisStreamHandler(`${prefix}:slow`, () => new Promise(() => {})),
      ],
      { maxRetries: 1, timeoutMs: 50 },
    );

    await admin.xAdd(stream, "*", { eventType: `${prefix}:slow` });

    await waitFor(async () => (await admin.xLen(dlqStream(stream))) === 1);
    const [entry] = await admin.xRange(dlqStream(stream), "-", "+");
    expect(entry.message.error).toContain("timed out");
  });

  it("emits flat events that another consumer can dispatch", async () => {
    const outStream = `${prefix}out:events`;
    await startConsumer([
      redisStreamHandler(`${prefix}:in`, async (ev, ctx) => {
        await ctx.emit({
          type: `${prefix}out:done`,
          data: { userId: ev.userId, ok: true, missing: null },
        });
      }),
    ]);

    await admin.xAdd(stream, "*", { eventType: `${prefix}:in`, userId: "u1" });

    await waitFor(async () => (await admin.xLen(outStream)) === 1);
    const [entry] = await admin.xRange(outStream, "-", "+");
    expect(entry.message).toEqual({
      eventType: `${prefix}out:done`,
      userId: "u1",
      ok: "true",
      missing: "",
    });
  });

  it("reclaims messages left pending by a dead consumer", async () => {
    const group = groupName(service);
    await admin.xGroupCreate(stream, group, "0", { MKSTREAM: true });
    await admin.xAdd(stream, "*", { eventType: `${prefix}:orphan` });
    // Simulate a consumer that read the message and then crashed.
    await admin.xReadGroup(group, "dead-consumer", { key: stream, id: ">" });

    const seen: string[] = [];
    await startConsumer(
      [
        redisStreamHandler(`${prefix}:orphan`, async (_, ctx) => {
          seen.push(ctx.id);
        }),
      ],
      { claimIdleMs: 0, claimIntervalMs: 0 },
    );

    await waitFor(async () => seen.length === 1);
    expect((await admin.xPending(stream, group)).pending).toBe(0);
  });

  it("recreates the consumer group if the stream is deleted", async () => {
    const seen: string[] = [];
    await startConsumer([
      redisStreamHandler(`${prefix}:ping`, async (ev) => {
        seen.push(ev.n);
      }),
    ]);
    await waitFor(async () => (await admin.exists(stream)) === 1);

    await admin.del(stream);
    await waitFor(async () => (await admin.exists(stream)) === 1);
    await admin.xAdd(stream, "*", { eventType: `${prefix}:ping`, n: "after" });

    await waitFor(async () => seen.includes("after"));
  });

  it("delivers typed events with their original types", async () => {
    const Order = defineEvent(
      `${prefix}:order`,
      z.object({
        total: z.number(),
        paid: z.boolean(),
        items: z.array(z.object({ sku: z.string(), qty: z.number() })),
      }),
    );
    const seen: unknown[] = [];
    await startConsumer([
      redisStreamHandler(Order, async (order) => {
        seen.push(order);
      }),
    ]);

    const { fields } = encodeEvent(Order, {
      total: 12.5,
      paid: true,
      items: [{ sku: "A1", qty: 2 }],
    });
    await admin.xAdd(stream, "*", fields);

    await waitFor(async () => seen.length === 1);
    expect(seen[0]).toEqual({
      total: 12.5,
      paid: true,
      items: [{ sku: "A1", qty: 2 }],
    });
  });

  it("dead-letters invalid typed payloads without retrying", async () => {
    const Order = defineEvent(`${prefix}:order`, z.object({ total: z.number() }));
    const handler = vi.fn(async () => {});
    await startConsumer([redisStreamHandler(Order, handler)], {
      maxRetries: 3,
    });

    await admin.xAdd(stream, "*", {
      eventType: `${prefix}:order`,
      payload: JSON.stringify({ total: "lots" }),
    });

    await waitFor(async () => (await admin.xLen(dlqStream(stream))) === 1);
    const [entry] = await admin.xRange(dlqStream(stream), "-", "+");
    expect(handler).not.toHaveBeenCalled();
    expect(entry.message.attempts).toBe("0");
    expect(entry.message.error).toContain("Invalid payload");
    expect((await admin.xPending(stream, groupName(service))).pending).toBe(0);
  });

  it("parses flat fields from untyped producers with coercing schemas", async () => {
    const Ping = defineEvent(
      `${prefix}:ping`,
      z.object({ n: z.coerce.number() }),
    );
    const seen: number[] = [];
    await startConsumer([
      redisStreamHandler(Ping, async ({ n }) => {
        seen.push(n);
      }),
    ]);

    await admin.xAdd(stream, "*", { eventType: `${prefix}:ping`, n: "7" });

    await waitFor(async () => seen.length === 1);
    expect(seen).toEqual([7]);
  });

  it("publishes typed events from a handler", async () => {
    const In = defineEvent(`${prefix}:in`, z.object({ userId: z.string() }));
    const Out = defineEvent(
      `${prefix}out:done`,
      z.object({ userId: z.string(), at: z.number() }),
    );
    await startConsumer([
      redisStreamHandler(In, async ({ userId }, ctx) => {
        await ctx.publish(Out, { userId, at: 1 });
      }),
    ]);

    await admin.xAdd(stream, "*", encodeEvent(In, { userId: "u9" }).fields);

    const outStream = `${prefix}out:events`;
    await waitFor(async () => (await admin.xLen(outStream)) === 1);
    const [entry] = await admin.xRange(outStream, "-", "+");
    expect(entry.message.eventType).toBe(`${prefix}out:done`);
    expect(JSON.parse(entry.message.payload)).toEqual({ userId: "u9", at: 1 });
  });

  it("stops promptly while blocked on XREADGROUP", async () => {
    const consumer = await startConsumer([], { blockMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
