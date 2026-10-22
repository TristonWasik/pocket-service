/// <reference types="vitest/globals" />
import { Service } from "../../src/core/service";

describe("Redis Dependency", () => {
  let service: Service<{}>;

  beforeAll(async () => {
    service = await new Service()
      .withName("redis-spec-service")
      .withPort(3103)
      .withRedis("redis://localhost:6379")
      .build();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  it("Should not throw an error when accessing redis", () => {
    expect(() => service.redis).not.toThrow();
  });

  it("Should register the service in redis during build", async () => {
    const value = await service.redis.get(
      "services:registry:redis-spec-service",
    );
    expect(value).not.toBeNull();
    const parsedValue = JSON.parse(value!);
    expect(parsedValue.name).toBe("redis-spec-service");
    expect(parsedValue.streamKey).toBe("redis:events");
    expect(parsedValue.url).toBe("http://localhost:3103");
    expect(parsedValue.dependencies).toEqual(["redis"]);
    expect(
      parsedValue.routes.some(
        (s: any) => s.method === "GET" && s.path === "/health",
      ),
    ).toBeTruthy();
    expect(parsedValue.lastHeartbeat).toBeDefined();
  });
});
