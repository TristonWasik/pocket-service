/// <reference types="vitest/globals" />
import { MongoMemoryServer } from "mongodb-memory-server";
import { Service } from "../../src/core/service";

describe("Health probes", () => {
  it("reports live and ready, then not ready when MongoDB goes away", async () => {
    const mongoServer = await MongoMemoryServer.create();
    const service = await new Service()
      .withName("health-test")
      .withPort(4140)
      .withRedis("redis://localhost:6379")
      .withMongo({
        dbName: "health",
        uri: `${mongoServer.getUri()}?serverSelectionTimeoutMS=500`,
        collections: {},
      })
      .build();

    try {
      const live = await fetch("http://localhost:4140/health/live");
      expect(live.status).toBe(200);

      const ready = await fetch("http://localhost:4140/health/ready");
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        status: "ready",
        checks: { redis: "ok", mongo: "ok" },
      });

      await mongoServer.stop();

      const notReady = await fetch("http://localhost:4140/health/ready");
      const body = await notReady.json();
      expect(notReady.status).toBe(503);
      expect(body.status).toBe("not_ready");
      expect(body.checks.redis).toBe("ok");
      expect(body.checks.mongo).not.toBe("ok");
    } finally {
      await service.shutdown();
      await mongoServer.stop();
    }
  }, 20_000);

  it("includes custom module readiness hooks", async () => {
    let healthy = true;
    const service = await new Service()
      .withName("health-custom")
      .withPort(4141)
      .withModules([
        { name: "queue", init: async () => true, ready: () => healthy },
      ])
      .build();

    try {
      const ok = await fetch("http://localhost:4141/health/ready");
      expect((await ok.json()).checks).toEqual({ "custom:queue": "ok" });

      healthy = false;
      const down = await fetch("http://localhost:4141/health/ready");
      expect(down.status).toBe(503);
      expect((await down.json()).checks["custom:queue"]).toBe("Not ready");
    } finally {
      await service.shutdown();
    }
  });

  it("lists only real modules in /health", async () => {
    const service = await new Service()
      .withName("health-modules")
      .withPort(4142)
      .withRedis("redis://localhost:6379")
      .build();

    try {
      const body = await (await fetch("http://localhost:4142/health")).json();
      expect(body.modulesLoaded).toEqual(["redis"]);
    } finally {
      await service.shutdown();
    }
  });
});
