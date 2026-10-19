/// <reference types="vitest/globals" />
import { createServer } from "http";
import express from "express";
import {
  registerDefaultRoutes,
  resolveCorsOptions,
  setupExpressApp,
  startHttpServer,
  closeHttpServer,
  type ServiceApiRuntimeContext,
} from "../../src/core/service/api";
import { createLogger } from "../../src/core/logger";

function makeContext(): ServiceApiRuntimeContext {
  const use = vi.fn();

  return {
    logger: createLogger("api-test"),
    withoutExpressFlag: false,
    expressOptions: {
      asJson: false,
      corsWhitelist: ["*"],
      customMiddleware: [],
    },
    api: {
      use,
    } as any,
    routers: [],
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    name: "admin-service",
    getStatus: () => "running",
    startedAt: Date.now(),
    dependencies: new Map<string, unknown>(),
    getRoutes: () => [],
    getLoadedEventListeners: () => [],
    getIsWorkerRunning: () => false,
    getWorkerStatus: () => [],
    workerSubscriptions: ["admin:events"],
    getRedis: () => ({
      xRange: vi.fn(async () => []),
      xRevRange: vi.fn(async () => []),
      xAck: vi.fn(async () => 1),
      xAdd: vi.fn(async () => "ok"),
      xDel: vi.fn(async () => 1),
      xPending: vi.fn(async () => ({})),
    }),
    getAuthResolver: () => async () => ({ userId: "u-1" }),
    getReadinessChecks: () => ({}),
    internalAddRouter: vi.fn(),
  };
}

describe("service/api helpers", () => {
  it("registers only base routes when workers are not enabled", () => {
    const ctx = makeContext();

    registerDefaultRoutes(ctx);

    expect(ctx.internalAddRouter).toHaveBeenCalledTimes(1);
    expect((ctx.internalAddRouter as any).mock.calls[0][0]).toBe("/");
  });

  it("registers worker routes when redis and workers dependencies exist", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", true);
    ctx.dependencies.set("workers", true);

    registerDefaultRoutes(ctx);

    expect(ctx.internalAddRouter).toHaveBeenCalledTimes(2);
    expect((ctx.internalAddRouter as any).mock.calls[0][0]).toBe("/");
    expect((ctx.internalAddRouter as any).mock.calls[1][0]).toBe("/workers");
  });

  it("short-circuits setup when express is disabled", () => {
    const ctx = makeContext();
    ctx.withoutExpressFlag = true;

    setupExpressApp(ctx);

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Express server is disabled. Service built without Express.",
    );
    expect((ctx.api.use as any).mock.calls.length).toBe(0);
  });

  it("respects omitDefaultRoutes", () => {
    const ctx = makeContext();
    ctx.expressOptions = {
      asJson: false,
      corsWhitelist: ["*"],
      omitDefaultRoutes: true,
      customMiddleware: [],
    };

    setupExpressApp(ctx);

    expect(ctx.internalAddRouter).not.toHaveBeenCalled();
  });

  it("registers default routes when omitDefaultRoutes is false", () => {
    const ctx = makeContext();

    setupExpressApp(ctx);

    expect(ctx.internalAddRouter).toHaveBeenCalled();
  });

  it("allows any origin for a '*' whitelist", () => {
    expect(
      resolveCorsOptions({ asJson: true, corsWhitelist: ["*"] }),
    ).toEqual({ origin: "*" });
  });

  it("rejects a '*' whitelist combined with credentials", () => {
    expect(() =>
      resolveCorsOptions({
        asJson: true,
        corsWhitelist: ["*"],
        credentials: true,
      }),
    ).toThrow("cannot be combined with credentials");
  });

  it("passes explicit origins and credentials through", () => {
    expect(
      resolveCorsOptions({
        asJson: true,
        corsWhitelist: ["http://a.test"],
        credentials: true,
      }),
    ).toEqual({ origin: ["http://a.test"], credentials: true });
  });

  it("rejects when the port is already in use and frees it on close", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as { port: number }).port;

    await expect(
      startHttpServer({ api: express(), port, fullUrl: "", log }),
    ).rejects.toThrow("EADDRINUSE");

    await closeHttpServer(blocker);
    const server = await startHttpServer({
      api: express(),
      port,
      fullUrl: "",
      log,
    });
    await closeHttpServer(server);
  });
});
