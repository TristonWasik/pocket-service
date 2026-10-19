/// <reference types="vitest/globals" />
import {
  startService,
  type ServiceLifecycleContext,
} from "../../src/core/service/lifecycle";

function makeContext(
  events: string[] = [],
  deps: [string, unknown][] = [],
): ServiceLifecycleContext {
  const record =
    (name: string) =>
    async (): Promise<void> => {
      events.push(name);
    };
  return {
    dependencies: new Map<string, unknown>(deps),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectRedis: vi.fn(record("redis")),
    connectMongo: vi.fn(record("mongo")),
    ensureClickhouseTables: vi.fn(record("clickhouse")),
    startWorkers: vi.fn(() => {
      events.push("workers");
    }),
    register: vi.fn(record("register")),
    startHeartbeat: vi.fn(() => {
      events.push("heartbeat");
    }),
    startHttp: vi.fn(record("http")),
  };
}

describe("service/lifecycle startService", () => {
  it("starts dependencies, custom modules, workers, registry and HTTP in order", async () => {
    const events: string[] = [];
    const ctx = makeContext(events, [
      ["redis", true],
      ["mongoClient", true],
      ["workers", true],
      [
        "customDependencies",
        [
          { name: "a", init: async () => (events.push("custom:a"), true) },
          { name: "b", init: () => (events.push("custom:b"), true) },
        ],
      ],
    ]);

    await startService(ctx);

    expect(events.slice(0, 2).sort()).toEqual(["mongo", "redis"]);
    expect(events.slice(2)).toEqual([
      "custom:a",
      "custom:b",
      "workers",
      "register",
      "heartbeat",
      "http",
    ]);
    expect(ctx.ensureClickhouseTables).not.toHaveBeenCalled();
  });

  it("skips Redis-only steps without Redis", async () => {
    const ctx = makeContext();

    await startService(ctx);

    expect(ctx.connectRedis).not.toHaveBeenCalled();
    expect(ctx.register).not.toHaveBeenCalled();
    expect(ctx.startHeartbeat).not.toHaveBeenCalled();
    expect(ctx.startHttp).toHaveBeenCalled();
  });

  it("rejects with the module name when a core module fails, after all attempts settle", async () => {
    const ctx = makeContext([], [
      ["redis", true],
      ["mongoClient", true],
    ]);
    let redisSettled = false;
    ctx.connectRedis = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      redisSettled = true;
    });
    ctx.connectMongo = vi.fn(async () => {
      throw new Error("connection refused");
    });

    await expect(startService(ctx)).rejects.toThrow(
      'Failed to initialize module "mongoClient": connection refused',
    );
    expect(redisSettled).toBe(true);
    expect(ctx.startHttp).not.toHaveBeenCalled();
  });

  it("rejects when a custom module throws", async () => {
    const ctx = makeContext([], [
      [
        "customDependencies",
        [
          {
            name: "bad-module",
            init: () => {
              throw new Error("boom");
            },
          },
        ],
      ],
    ]);

    await expect(startService(ctx)).rejects.toThrow(
      'Failed to initialize custom module "bad-module": boom',
    );
  });

  it("rejects when a custom module init returns false", async () => {
    const ctx = makeContext([], [
      ["customDependencies", [{ name: "nope", init: async () => false }]],
    ]);

    await expect(startService(ctx)).rejects.toThrow(
      'Custom module "nope" init returned false.',
    );
    expect(ctx.startHttp).not.toHaveBeenCalled();
  });
});
