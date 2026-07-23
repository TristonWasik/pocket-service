/// <reference types="vitest/globals" />
import z from "zod";
import { defineMongoCollection } from "../src/workers/db/mongo/mongo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Service } from "../src/workers/service";
import { CustomModules } from "../src/workers/types";
import type { Request } from "express";
import type { RouteDefinition } from "../src/workers/express-types";

const secureRoute: RouteDefinition<any, any, boolean> = {
  method: "GET",
  fullPath: "/secure",
  requireAuth: true,
};

describe("Service Class", () => {
  it("Should be able to be initialized", async () => {
    const service = new Service()
      .withName("admin-service")
      .withPort(3000)
      .build();
    expect(service.simpleName).toBe("admin");
    expect(() => service.log.info("Service initialized")).not.toThrow();
  });

  it("Should throw error if accessing uninitialized dependencies", async () => {
    const service = new Service().withName("admin-service").build();
    expect(() => service.redis).toThrow("Redis module has not been added.");
    expect(() => service.clickhouse).toThrow(
      "Clickhouse module has not been added.",
    );
  });

  it("Should initialize Redis dependency", async () => {
    const service = new Service()
      .withName("admin-service")
      .withRedis("redis://localhost:6379")
      .build();
    expect(() => service.redis).not.toThrow();
  });

  it("Should initialize MongoDB dependency", async () => {
    const mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    const service = new Service()
      .withName("admin-service")
      .withPort(4120)
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
      })
      .build();

    expect(() => service.mongo).not.toThrow();
    await mongoServer.stop();
  });

  it("Should allow custom dependencies", async () => {
    const service = new Service()
      .withName("admin-service")
      .withPort(4120)
      .withModules([
        {
          name: "doSomething",
          init: async (log) => {
            log.info("Initializing custom dependency");
            return true;
          },
        },
      ])
      .withRedis("redis://localhost:6379")
      .build();
    expect(service["dependencies"].has("customDependencies")).toBe(true);
    const customDeps = service["dependencies"].get(
      "customDependencies",
    ) as CustomModules;
    expect(customDeps).toBeDefined();
    expect(customDeps[0].name).toBe("doSomething");
    expect(await customDeps[0].init(service.log)).toBe(true);
    expect(customDeps[0].shutdown).toBeUndefined();
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
