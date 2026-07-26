/// <reference types="vitest/globals" />

const { existsSyncMock, readdirSyncMock, workerCtorMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readdirSyncMock: vi.fn(),
  workerCtorMock: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
}));

vi.mock("worker_threads", () => ({
  Worker: workerCtorMock,
}));

import {
  loadHandlers,
  runWorkers,
  type ServiceWorkerContext,
} from "../../src/core/service/workers";

function makeContext(): ServiceWorkerContext {
  return {
    name: "admin-service",
    dependencies: new Map<string, unknown>(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    handlers: {},
    redis: {
      options: {
        url: "redis://localhost:6379",
      },
    },
    workerCount: 1,
    serviceStreamSubscriptions: ["admin:events"],
    isWorkerRunning: false,
    loadedEventListeners: [],
  };
}

describe("service/workers helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips handler loading when redis dependency is missing", () => {
    const ctx = makeContext();

    loadHandlers(ctx);

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Redis module not initialized. Skipping handler loading.",
    );
  });

  it("warns when handlers directory is missing", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    existsSyncMock.mockReturnValue(false);

    loadHandlers(ctx);

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Handlers directory does not exist.",
    );
  });

  it("loads only ts/js handlers", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue(["alpha.ts", "beta.js", "notes.md"]);

    loadHandlers(ctx);

    expect(ctx.handlers).toHaveProperty("alpha");
    expect(ctx.handlers).toHaveProperty("beta");
    expect(ctx.handlers).not.toHaveProperty("notes");
  });

  it("throws for invalid worker count", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);

    expect(() => runWorkers(ctx, { workerCount: 0 })).toThrow(
      "Worker count must be a number greater than 0.",
    );
  });

  it("starts workers and maps worker messages to logger methods", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    existsSyncMock.mockReturnValue(true);

    const handlers: Record<string, (...args: any[]) => void> = {};
    const workerInstance = {
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
      }),
    };

    workerCtorMock.mockImplementation(() => workerInstance);

    runWorkers(ctx, { workerCount: 1 });

    expect(workerCtorMock).toHaveBeenCalledTimes(1);
    expect(ctx.isWorkerRunning).toBe(true);

    handlers.message?.({ level: "warn", message: "warn-msg" });
    handlers.message?.({ level: "error", message: "error-msg" });
    handlers.message?.({ level: "info", message: "info-msg" });
    handlers.message?.({ level: "create", message: ["handler-a"] });

    expect(ctx.log.warn).toHaveBeenCalledWith("warn-msg");
    expect(ctx.log.error).toHaveBeenCalledWith("error-msg");
    expect(ctx.log.info).toHaveBeenCalledWith("info-msg");
    expect(ctx.loadedEventListeners).toEqual(["handler-a"]);

    handlers.exit?.(0);
    expect(ctx.isWorkerRunning).toBe(false);
  });

  it("skips worker startup when no worker entry file can be resolved", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    existsSyncMock.mockReturnValue(false);

    runWorkers(ctx, { workerCount: 1 });

    expect(workerCtorMock).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Worker thread entry file not found. Skipping worker setup.",
    );
  });
});
