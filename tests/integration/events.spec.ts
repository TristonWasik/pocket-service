/// <reference types="vitest/globals" />
import { randomBytes } from "crypto";
import z from "zod";
import { Service } from "../../src/core/service";
import { defineEvent } from "../../src/runtime/events";

describe("service.publish", () => {
  let service: Service;
  const prefix = `ev${randomBytes(4).toString("hex")}`;
  const UserCreated = defineEvent(
    `${prefix}:user-created`,
    z.object({ userId: z.string(), plan: z.enum(["free", "pro"]) }),
  );

  beforeAll(async () => {
    service = await new Service()
      .withName("events-test")
      .withPort(4150)
      .withRedis("redis://localhost:6379")
      .build();
  });

  afterAll(async () => {
    await service.redis.del(`${prefix}:events`);
    await service.shutdown();
  });

  it("writes a validated event to the event's stream", async () => {
    const id = await service.publish(UserCreated, {
      userId: "u1",
      plan: "pro",
    });

    const [entry] = await service.redis.xRange(`${prefix}:events`, id, id);
    expect(entry.message).toEqual({
      eventType: `${prefix}:user-created`,
      payload: JSON.stringify({ userId: "u1", plan: "pro" }),
    });
  });

  it("rejects payloads that do not match the schema", async () => {
    await expect(
      service.publish(UserCreated, { userId: "u1", plan: "gold" as any }),
    ).rejects.toThrow(`Invalid payload for event "${prefix}:user-created"`);
  });

  it("trims the stream when maxLen is set", async () => {
    for (let i = 0; i < 300; i++) {
      await service.publish(
        UserCreated,
        { userId: `u${i}`, plan: "free" },
        { maxLen: 50 },
      );
    }
    // MAXLEN ~ trims whole macro nodes, so the length is approximate.
    expect(await service.redis.xLen(`${prefix}:events`)).toBeLessThan(300);
  });
});
