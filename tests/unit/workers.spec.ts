/// <reference types="vitest/globals" />
import { EventEmitter } from "events";

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
  discoverHandlers,
  resolveHandlersDir,
  startWorkers,
  WorkerPool,
  type ServiceWorkerContext,
} from "../../src/core/service/workers";

class FakeWorker extends EventEmitter {
  postMessage = vi.fn((msg: { type: string }) => {
    if (msg.type === "stop") this.emit("exit", 0);
  });
  terminate = vi.fn(async () => 1);
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeContext(): ServiceWorkerContext {
  return {
    name: "admin-service",
    dependencies: new Map<string, unknown>([
      ["redis", true],
      [
        "workers",
        { workerCount: 1, subscriptions: ["admin:events"], options: {} },
      ],
    ]),
    log: makeLog(),
    redisUrl: "redis://localhost:6379",
  };
}

function makePool(options = {}) {
  return new WorkerPool({
    name: "admin-service",
    entry: new URL("file:///worker.mjs"),
    handlers: { alpha: "/handlers/alpha.js" },
    workerCount: 1,
    subscriptions: ["admin:events"],
    options,
    log: makeLog(),
  });
}

describe("service/workers helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerCtorMock.mockImplementation(() => new FakeWorker());
  });

  it("prefers an explicit handlers directory", () => {
    existsSyncMock.mockReturnValue(true);
    expect(resolveHandlersDir("/app/dist/handlers")).toBe("/app/dist/handlers");
  });

  it("returns null when no handlers directory exists", () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolveHandlersDir()).toBeNull();
  });

  it("discovers js/mjs/ts handler files and skips declarations", () => {
    readdirSyncMock.mockReturnValue([
      "alpha.ts",
      "beta.js",
      "gamma.mjs",
      "types.d.ts",
      "notes.md",
    ]);

    const handlers = discoverHandlers("/handlers");

    expect(Object.keys(handlers).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns null without a workers dependency", () => {
    const ctx = makeContext();
    ctx.dependencies.delete("workers");
    expect(startWorkers(ctx)).toBeNull();
  });

  it("throws for invalid worker count", () => {
    const ctx = makeContext();
    ctx.dependencies.set("workers", {
      workerCount: 0,
      subscriptions: ["admin:events"],
      options: {},
    });

    expect(() => startWorkers(ctx)).toThrow(
      "Worker count must be an integer greater than 0.",
    );
  });

  it("does not start workers when no handlers are found", () => {
    const ctx = makeContext();
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue([]);

    expect(startWorkers(ctx)).toBeNull();
    expect(workerCtorMock).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No handlers found"),
    );
  });

  it("reports state from worker messages", () => {
    const pool = makePool();
    pool.start();
    const worker = workerCtorMock.mock.results[0].value as FakeWorker;

    expect(pool.isRunning).toBe(false);
    worker.emit("message", { level: "ready" });
    worker.emit("message", { level: "create", message: ["user:created"] });

    expect(pool.isRunning).toBe(true);
    expect(pool.loadedHandlers).toEqual(["user:created"]);
    expect(workerCtorMock.mock.calls[0][1].workerData).toMatchObject({
      name: "admin-service",
      index: 0,
      subscriptions: ["admin:events"],
    });
  });

  it("restarts a crashed worker and gives up after maxRestarts", () => {
    vi.useFakeTimers();
    const pool = makePool({ maxRestarts: 1 });
    pool.start();

    (workerCtorMock.mock.results[0].value as FakeWorker).emit("exit", 1);
    expect(pool.status[0].state).toBe("restarting");

    vi.advanceTimersByTime(1000);
    expect(workerCtorMock).toHaveBeenCalledTimes(2);

    (workerCtorMock.mock.results[1].value as FakeWorker).emit("exit", 1);
    expect(pool.status[0]).toMatchObject({ state: "failed", restarts: 1 });
    vi.useRealTimers();
  });

  it("stops workers by message and does not restart them", async () => {
    const pool = makePool();
    pool.start();
    const worker = workerCtorMock.mock.results[0].value as FakeWorker;

    await pool.stop();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(pool.status[0].state).toBe("exited");
  });

  it("terminates workers that do not stop in time", async () => {
    vi.useFakeTimers();
    const pool = makePool({ shutdownTimeoutMs: 50 });
    pool.start();
    const worker = workerCtorMock.mock.results[0].value as FakeWorker;
    worker.postMessage.mockImplementation(() => {});
    worker.terminate.mockImplementation(async () => {
      worker.emit("exit", 1);
      return 1;
    });

    const stopped = pool.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopped;

    expect(worker.terminate).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
