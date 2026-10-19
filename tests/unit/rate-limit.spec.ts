/// <reference types="vitest/globals" />
import type { Request } from "express";
import {
  createMemoryRateLimitStore,
  createRateLimiter,
} from "../../src/api/rate-limit";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const req = (ip: string, userId?: string) =>
  ({ ip, user: userId ? { userId } : undefined }) as unknown as Request;

describe("rate limiter", () => {
  it("limits per caller within a fixed window and resets after it", async () => {
    let time = 1_000_000;
    const now = () => time;
    const limiter = createRateLimiter({
      options: { strict: { limit: 2, windowMs: 1_000 } },
      store: createMemoryRateLimitStore(now),
      prefix: "t",
      log,
      now,
    });

    const a = req("1.1.1.1");
    expect((await limiter.check(a, "strict"))!.remaining).toBe(1);
    expect((await limiter.check(a, "strict"))!.allowed).toBe(true);
    const blocked = (await limiter.check(a, "strict"))!;
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, limit: 2 });
    expect(blocked.resetSeconds).toBe(1);

    expect((await limiter.check(req("2.2.2.2"), "strict"))!.allowed).toBe(
      true,
    );

    time += 1_000;
    expect((await limiter.check(a, "strict"))!.allowed).toBe(true);
  });

  it("keys by user before IP, and by keyBy before both", async () => {
    const store = { hit: vi.fn(async () => 1) };
    const limiter = createRateLimiter({
      options: {},
      store,
      prefix: "svc",
      log,
      now: () => 0,
    });
    await limiter.check(req("1.1.1.1", "u1"), "standard");
    expect(store.hit.mock.calls[0][0]).toBe("svc:standard:u1:0");

    const custom = createRateLimiter({
      options: { keyBy: () => "tenant-9" },
      store,
      prefix: "svc",
      log,
      now: () => 0,
    });
    await custom.check(req("1.1.1.1", "u1"), "strict");
    expect(store.hit.mock.calls[1][0]).toBe("svc:strict:tenant-9:0");
  });

  it("allows requests when the store fails", async () => {
    const limiter = createRateLimiter({
      options: {},
      store: {
        hit: async () => {
          throw new Error("redis down");
        },
      },
      prefix: "svc",
      log,
    });

    expect(await limiter.check(req("1.1.1.1"), "standard")).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("redis down"),
    );
  });

  it("defaults to no limit for routes without a tier", () => {
    const limiter = createRateLimiter({
      options: {},
      store: createMemoryRateLimitStore(),
      prefix: "svc",
      log,
    });
    expect(limiter.defaultTier).toBe("none");
  });
});
