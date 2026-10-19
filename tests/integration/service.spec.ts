/// <reference types="vitest/globals" />
import z from "zod";
import { defineMongoCollection } from "../../src/modules/mongo/mongo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Service } from "../../src/core/service";
import { CustomModules } from "../../src/core/types";
import type { Request } from "express";
import type { RouteDefinition } from "../../src/api/express-types";
import { createClient } from "redis";

const secureRoute: RouteDefinition<any, any, boolean> = {
  method: "GET",
  fullPath: "/secure",
  requireAuth: true,
};

describe("Service Class", () => {
  const started: Service<any>[] = [];
  const track = <T extends Service<any>>(service: T) => {
    started.push(service);
    return service;
  };

  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.shutdown()));
  });

  it("Should be able to be initialized", async () => {
    const service = await track(
      new Service().withName("admin-service").withPort(4100),
    ).build();
    expect(service.simpleName).toBe("admin");
    expect(service.status).toBe("running");
    expect(() => service.log.info("Service initialized")).not.toThrow();
  });

  it("Should return the same promise when build() is called twice", async () => {
    const service = track(new Service().withName("twice").withPort(4101));
    expect(service.build()).toBe(service.build());
    await service.build();
  });

  it("Should throw error if accessing uninitialized dependencies", async () => {
    const service = await track(
      new Service().withName("admin-service").withPort(4102),
    ).build();
    expect(() => service.redis).toThrow("Redis module has not been added.");
    expect(() => service.clickhouse).toThrow(
      "Clickhouse module has not been added.",
    );
  });

  it("Should initialize Redis dependency", async () => {
    const service = await track(
      new Service()
        .withName("admin-service")
        .withPort(4103)
        .withRedis("redis://localhost:6379"),
    ).build();
    expect(service.redis.isOpen).toBe(true);
  });

  it("Should initialize MongoDB dependency", async () => {
    const mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    const service = new Service()
      .withName("admin-service")
      .withPort(4104)
      .withRedis("redis://localhost:6379")
      .withMongo({
        dbName: "test",
        uri,
        collections: {
          testCollection: defineMongoCollection({
            schema: z.object({
              name: z.string(),
            }),
          }),
        },
      });
    await track(service).build();

    expect(() => service.mongo).not.toThrow();
    await service.shutdown();
    await mongoServer.stop();
  });

  it("Should allow custom dependencies", async () => {
    const service = await track(
      new Service()
        .withName("admin-service")
        .withPort(4105)
        .withModules([
          {
            name: "doSomething",
            init: async (log) => {
              log.info("Initializing custom dependency");
              return true;
            },
          },
        ])
        .withRedis("redis://localhost:6379"),
    ).build();
    expect(service["dependencies"].has("customDependencies")).toBe(true);
    const customDeps = service["dependencies"].get(
      "customDependencies",
    ) as CustomModules;
    expect(customDeps).toBeDefined();
    expect(customDeps[0].name).toBe("doSomething");
    expect(await customDeps[0].init(service.log)).toBe(true);
    expect(customDeps[0].shutdown).toBeUndefined();
  });

  it("Should reject build() and clean up when MongoDB is unreachable", async () => {
    const service = new Service()
      .withName("mongo-down")
      .withPort(4106)
      .withRedis("redis://localhost:6379")
      .withMongo({
        dbName: "test",
        uri: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300",
        collections: {},
      });

    await expect(service.build()).rejects.toThrow(
      'Failed to initialize module "mongoClient"',
    );
    expect(service.status).toBe("stopped");
    expect(service.redis.isOpen).toBe(false);
  });

  it("Should reject build() when a custom module init returns false", async () => {
    const service = new Service()
      .withName("custom-false")
      .withPort(4107)
      .withModules([{ name: "nope", init: async () => false }]);

    await expect(service.build()).rejects.toThrow(
      'Custom module "nope" init returned false.',
    );
  });

  it("Should free the port and remove the registry entry on shutdown", async () => {
    const admin = createClient({ url: "redis://localhost:6379" });
    await admin.connect();
    const service = await new Service()
      .withName("shutdown-test")
      .withPort(4108)
      .withRedis("redis://localhost:6379")
      .build();

    expect(await admin.exists("services:registry:shutdown-test")).toBe(1);
    const exitSpy = vi.spyOn(process, "exit");

    await service.shutdown();

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    expect(service.status).toBe("stopped");
    expect(await admin.exists("services:registry:shutdown-test")).toBe(0);
    await expect(fetch("http://localhost:4108/")).rejects.toThrow();

    const again = await track(
      new Service().withName("port-reuse").withPort(4108),
    ).build();
    expect(again.status).toBe("running");
    await admin.close();
  });

  it("Should remove its signal handlers on shutdown", async () => {
    const before = process.listenerCount("SIGTERM");
    const service = await new Service().withName("signals").withPort(4109).build();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);

    await service.shutdown();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("Should send CORS headers for any origin by default", async () => {
    await track(new Service().withName("cors").withPort(4110)).build();

    const res = await fetch("http://localhost:4110/", {
      headers: { Origin: "http://example.test" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("Should prefer withAuthResolver over strategies and header fallback", async () => {
    const service = new Service()
      .withAuthStrategy({
        name: "strategy",
        authenticate: async () => ({ userId: "strategy-user" }),
      })
      .withAuthResolver(async () => ({ userId: "override-user" }));

    const resolver = (service as any).getAuthResolver() as (
      req: Request,
      route: RouteDefinition<any, any, boolean>,
    ) => Promise<{ userId: string } | null>;

    await expect(
      resolver(
        {
          headers: {
            "x-user-id": "header-user",
          },
        } as unknown as Request,
        secureRoute,
      ),
    ).resolves.toEqual({ userId: "override-user" });
  });

  it("Should disable default header fallback when configured", async () => {
    const service = new Service().withoutDefaultHeaderAuthFallback();

    const resolver = (service as any).getAuthResolver() as (
      req: Request,
      route: RouteDefinition<any, any, boolean>,
    ) => Promise<{ userId: string } | null>;

    await expect(
      resolver(
        {
          headers: {
            "x-user-id": "header-user",
          },
        } as unknown as Request,
        secureRoute,
      ),
    ).resolves.toBeNull();
  });

  it("Should use strategy result before header fallback", async () => {
    const service = new Service().withAuthStrategy({
      name: "strategy",
      authenticate: async () => ({ userId: "strategy-user" }),
    });

    const resolver = (service as any).getAuthResolver() as (
      req: Request,
      route: RouteDefinition<any, any, boolean>,
    ) => Promise<{ userId: string } | null>;

    await expect(
      resolver(
        {
          headers: {
            "x-user-id": "header-user",
          },
        } as unknown as Request,
        secureRoute,
      ),
    ).resolves.toEqual({ userId: "strategy-user" });
  });
});
