/// <reference types="vitest/globals" />
import { Router } from "express";

const { createClientMock, createMongoMock, createTypedClickhouseMock } =
  vi.hoisted(() => ({
    createClientMock: vi.fn(() => ({ mocked: true })),
    createMongoMock: vi.fn(() => ({ mocked: "mongo" })),
    createTypedClickhouseMock: vi.fn(() => ({ mocked: "clickhouse" })),
  }));

vi.mock("redis", () => ({
  createClient: createClientMock,
}));

vi.mock("../../src/modules/mongo/mongo", () => ({
  createMongo: createMongoMock,
}));

vi.mock("../../src/modules/clickhouse", () => ({
  createTypedClickhouse: createTypedClickhouseMock,
}));

import {
  addAuthStrategy,
  addClickhouseDependency,
  addMongoDependency,
  addRedisDependency,
  addRouterRegistration,
  addWorkerDependency,
  setExpressOptions,
  type ServiceConfigContext,
} from "../../src/core/service/config";

function makeContext(): ServiceConfigContext {
  return {
    dependencies: new Map<string, unknown>(),
    dependencyOrder: [],
    log: {
      warn: vi.fn(),
    },
    withoutExpressFlag: false,
    expressOptions: {
      asJson: true,
      corsWhitelist: ["*"],
      customMiddleware: [],
    },
    authStrategies: [],
    authResolverOverride: undefined,
    useDefaultHeaderAuthFallback: true,
    serviceStreamSubscriptions: [],
    workerCount: 1,
    routers: [],
  };
}

describe("service/config helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds redis dependency once", () => {
    const ctx = makeContext();

    addRedisDependency(ctx, "redis://localhost:6379");
    addRedisDependency(ctx, "redis://localhost:6379");

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(ctx.dependencies.has("redis")).toBe(true);
    expect(ctx.dependencyOrder).toEqual(["redis"]);
  });

  it("adds mongo and clickhouse dependencies once", () => {
    const ctx = makeContext();

    addMongoDependency(ctx, {
      dbName: "test",
      collections: {},
      uri: "mongodb://localhost:27017",
    });
    addMongoDependency(ctx, {
      dbName: "test",
      collections: {},
    });
    addClickhouseDependency(ctx, {
      url: "http://localhost:8123",
      tables: {},
    });
    addClickhouseDependency(ctx, {
      url: "http://localhost:8123",
      tables: {},
    });

    expect(createMongoMock).toHaveBeenCalledTimes(1);
    expect(createTypedClickhouseMock).toHaveBeenCalledTimes(1);
    expect(ctx.dependencyOrder).toEqual(["mongoClient", "clickhouse"]);
  });

  it("warns when workers are configured before redis", () => {
    const ctx = makeContext();

    addWorkerDependency(ctx, 2, ["events"]);

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Redis module not initialized. Call withRedis() before setting worker subscriptions.",
    );
    expect(ctx.dependencies.has("workers")).toBe(false);
  });

  it("adds worker dependency and normalizes worker count", () => {
    const ctx = makeContext();
    ctx.dependencies.set("redis", { mocked: true });

    addWorkerDependency(ctx, 0, ["a:events", "b:events"]);

    expect(ctx.dependencies.get("workers")).toBe(true);
    expect(ctx.workerCount).toBe(1);
    expect(ctx.serviceStreamSubscriptions).toEqual(["a:events", "b:events"]);
    expect(ctx.dependencyOrder).toContain("workers");
  });

  it("does not register root router path", () => {
    const ctx = makeContext();
    const router = Router();

    addRouterRegistration(ctx, "/", router, []);

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Base path '/' is not allowed. Skipping.",
    );
    expect(ctx.routers).toHaveLength(0);
  });

  it("skips auth/express mutations when express is disabled", () => {
    const ctx = makeContext();
    ctx.withoutExpressFlag = true;

    setExpressOptions(ctx, { credentials: true });
    addAuthStrategy(ctx, {
      name: "noop",
      authenticate: async () => ({ userId: "x" }),
    });

    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Express server is disabled. Express options will not be applied.",
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "Express server is disabled. Auth strategies will not be applied.",
    );
    expect(ctx.authStrategies).toHaveLength(0);
    expect(ctx.expressOptions.credentials).toBeUndefined();
  });
});
