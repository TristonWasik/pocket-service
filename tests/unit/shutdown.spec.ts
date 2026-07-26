/// <reference types="vitest/globals" />
import {
  shutdownService,
  type ServiceShutdownContext,
} from "../../src/core/service/shutdown";

function makeContext(): ServiceShutdownContext {
  return {
    dependencies: new Map<string, unknown>(),
    quitRedis: vi.fn(async () => true),
    disconnectMongo: vi.fn(async () => true),
    closeClickhouse: vi.fn(async () => true),
    log: {
      info: vi.fn(),
      error: vi.fn(),
    },
    name: "admin-service",
    setStatus: vi.fn(),
  };
}

describe("service/shutdown helper", () => {
  it("runs shutdown sequence in order and exits", async () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    ctx.dependencies.set("mongoClient", true);
    ctx.dependencies.set("clickhouse", true);
    ctx.dependencies.set("customDependencies", [
      {
        name: "custom-a",
        init: vi.fn(),
        shutdown: vi.fn(async () => true),
      },
    ]);

    const events: string[] = [];
    (ctx.setStatus as any).mockImplementation((status: string) => {
      events.push(`status:${status}`);
    });
    (ctx.quitRedis as any).mockImplementation(async () => {
      events.push("redis");
    });
    (ctx.disconnectMongo as any).mockImplementation(async () => {
      events.push("mongo");
    });
    (ctx.closeClickhouse as any).mockImplementation(async () => {
      events.push("clickhouse");
    });
    (ctx.dependencies.get("customDependencies") as any[])[0].shutdown = vi.fn(
      async () => {
        events.push("custom-a");
        return true;
      },
    );

    const beforeShutdown = vi.fn(async () => {
      events.push("before");
    });
    const afterShutdown = vi.fn(async () => {
      events.push("after");
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      events.push(`exit:${code ?? 0}`);
      return undefined as never;
    }) as unknown as (code?: string | number | null | undefined) => never);

    await shutdownService(ctx, { beforeShutdown, afterShutdown });

    expect(events).toEqual([
      "before",
      "status:stopping",
      "redis",
      "mongo",
      "clickhouse",
      "custom-a",
      "status:stopped",
      "after",
      "exit:0",
    ]);

    expect(ctx.log.info).toHaveBeenCalledWith(
      "Service admin-service shutting down.",
    );

    exitSpy.mockRestore();
  });

  it("logs custom shutdown failures and continues", async () => {
    const ctx = makeContext();
    ctx.dependencies.set("customDependencies", [
      {
        name: "bad-shutdown",
        init: vi.fn(),
        shutdown: vi.fn(async () => {
          throw new Error("failed");
        }),
      },
      {
        name: "good-shutdown",
        init: vi.fn(),
        shutdown: vi.fn(async () => true),
      },
    ]);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (() => undefined as never) as unknown as (
          code?: string | number | null | undefined,
        ) => never,
      );

    await shutdownService(ctx);

    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to shutdown custom dependency "bad-shutdown"',
      ),
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Custom dependency "good-shutdown" shutdown with result: true',
      ),
    );

    exitSpy.mockRestore();
  });
});
