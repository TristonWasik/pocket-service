/// <reference types="vitest/globals" />
import {
  registerDefaultRoutes,
  setupExpressApp,
  type ServiceApiRuntimeContext,
} from "../../src/core/service/api";

function makeContext(): ServiceApiRuntimeContext {
  const use = vi.fn();
  const listen = vi.fn((_: number, cb: () => void) => cb());

  return {
    withoutExpressFlag: false,
    expressOptions: {
      asJson: false,
      corsWhitelist: ["*"],
      customMiddleware: [],
    },
    api: {
      use,
      listen,
    } as any,
    routers: [],
    fullUrl: "http://localhost:3100",
    port: 3100,
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
    handlers: {},
    getIsWorkerRunning: () => false,
    streamKey: "admin:events",
    simpleName: "admin",
    getRedis: () => ({
      xRange: vi.fn(async () => []),
      xAck: vi.fn(async () => 1),
      xAdd: vi.fn(async () => "ok"),
    }),
    getAuthResolver: () => async () => ({ userId: "u-1" }),
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
    expect((ctx.api.listen as any).mock.calls.length).toBe(0);
  });

  it("respects omitDefaultRoutes and still starts the API", () => {
    const ctx = makeContext();
    ctx.expressOptions = {
      asJson: false,
      corsWhitelist: ["*"],
      omitDefaultRoutes: true,
      customMiddleware: [],
    };

    setupExpressApp(ctx);

    expect(ctx.internalAddRouter).not.toHaveBeenCalled();
    expect((ctx.api.listen as any).mock.calls.length).toBe(1);
  });

  it("registers default routes when omitDefaultRoutes is false", () => {
    const ctx = makeContext();

    setupExpressApp(ctx);

    expect(ctx.internalAddRouter).toHaveBeenCalled();
    expect((ctx.api.listen as any).mock.calls.length).toBe(1);
  });
});
