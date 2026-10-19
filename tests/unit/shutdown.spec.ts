/// <reference types="vitest/globals" />
import {
  shutdownService,
  type ServiceShutdownContext,
} from "../../src/core/service/shutdown";

function makeContext(events: string[] = []): ServiceShutdownContext {
  const record = (name: string) => vi.fn(async () => void events.push(name));
  return {
    dependencies: new Map<string, unknown>(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    name: "admin-service",
    setStatus: vi.fn((status: string) => void events.push(`status:${status}`)),
    closeHttp: record("http"),
    stopWorkers: record("workers"),
    stopHeartbeat: record("registry"),
    closeRedis: record("redis"),
    disconnectMongo: record("mongo"),
    closeClickhouse: record("clickhouse"),
  };
}

describe("service/shutdown helper", () => {
  it("stops everything in reverse startup order without exiting", async () => {
    const events: string[] = [];
    const ctx = makeContext(events);
    ctx.dependencies.set("redis", true);
    ctx.dependencies.set("mongoClient", true);
    ctx.dependencies.set("clickhouse", true);
    ctx.dependencies.set("customDependencies", [
      { name: "a", init: vi.fn(), shutdown: async () => (events.push("custom:a"), true) },
      { name: "b", init: vi.fn(), shutdown: async () => (events.push("custom:b"), true) },
    ]);
    const exitSpy = vi.spyOn(process, "exit");

    await shutdownService(ctx, {
      beforeShutdown: async () => void events.push("before"),
      afterShutdown: async () => void events.push("after"),
    });

    expect(events).toEqual([
      "before",
      "status:stopping",
      "http",
      "workers",
      "registry",
      "custom:b",
      "custom:a",
      "clickhouse",
      "mongo",
      "redis",
      "status:stopped",
      "after",
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("skips modules that were not configured", async () => {
    const ctx = makeContext();

    await shutdownService(ctx);

    expect(ctx.closeRedis).not.toHaveBeenCalled();
    expect(ctx.disconnectMongo).not.toHaveBeenCalled();
    expect(ctx.closeClickhouse).not.toHaveBeenCalled();
    expect(ctx.closeHttp).toHaveBeenCalled();
  });

  it("logs failing steps and keeps going", async () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    ctx.closeHttp = vi.fn(async () => {
      throw new Error("server stuck");
    });
    ctx.dependencies.set("customDependencies", [
      {
        name: "bad-shutdown",
        init: vi.fn(),
        shutdown: vi.fn(async () => {
          throw new Error("failed");
        }),
      },
      { name: "good-shutdown", init: vi.fn(), shutdown: vi.fn(async () => true) },
    ]);

    await shutdownService(ctx);

    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining('Shutdown step "http" failed'),
    );
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining('Shutdown step "custom:bad-shutdown" failed'),
    );
    expect(ctx.log.info).toHaveBeenCalledWith(
      'Custom dependency "good-shutdown" shutdown with result: true',
    );
    expect(ctx.closeRedis).toHaveBeenCalled();
    expect(ctx.setStatus).toHaveBeenLastCalledWith("stopped");
  });
});
