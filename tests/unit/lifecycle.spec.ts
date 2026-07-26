/// <reference types="vitest/globals" />
import {
  initializeDependencies,
  type ServiceLifecycleContext,
} from "../../src/core/service/lifecycle";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function makeContext(): ServiceLifecycleContext {
  return {
    dependencyOrder: [],
    dependencies: new Map<string, unknown>(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    loadHandlers: vi.fn(),
    runWorkers: vi.fn(),
    connectRedis: vi.fn(async () => true),
    register: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    connectMongo: vi.fn(async () => true),
    ensureClickhouseTables: vi.fn(async () => undefined),
  };
}

describe("service/lifecycle helpers", () => {
  it("initializes redis path and starts workers when workers dependency exists", async () => {
    const ctx = makeContext();
    ctx.dependencyOrder = ["redis"];
    ctx.dependencies.set("workers", true);

    const processOnSpy = vi
      .spyOn(process, "on")
      .mockImplementation((() => process) as any);

    initializeDependencies(ctx);
    await flush();

    expect(ctx.loadHandlers).toHaveBeenCalledTimes(1);
    expect(ctx.runWorkers).toHaveBeenCalledTimes(1);
    expect(ctx.connectRedis).toHaveBeenCalledTimes(1);
    expect(ctx.register).toHaveBeenCalledTimes(1);
    expect(ctx.heartbeat).toHaveBeenCalledTimes(1);
    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    processOnSpy.mockRestore();
  });

  it("warns when redis exists but workers are not configured", async () => {
    const ctx = makeContext();
    ctx.dependencyOrder = ["redis"];

    initializeDependencies(ctx);
    await flush();

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Worker module not initialized. Call withWorkers() to enable worker threads and dynamically load handlers.",
    );
    expect(ctx.loadHandlers).not.toHaveBeenCalled();
    expect(ctx.runWorkers).not.toHaveBeenCalled();
  });

  it("logs unknown dependency keys", async () => {
    const ctx = makeContext();
    ctx.dependencyOrder = ["mystery-module"];

    initializeDependencies(ctx);
    await flush();

    expect(ctx.log.info).toHaveBeenCalledWith(
      "Unknown module mystery-module during initialization.",
    );
  });

  it("logs custom dependency init failures without throwing", async () => {
    const ctx = makeContext();
    ctx.dependencies.set("customDependencies", [
      {
        name: "bad-module",
        init: () => {
          throw new Error("boom");
        },
      },
    ]);

    initializeDependencies(ctx);
    await flush();

    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to initialize custom module "bad-module"',
      ),
    );
  });
});
