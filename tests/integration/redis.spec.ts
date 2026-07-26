/// <reference types="vitest/globals" />
import { Service } from "../../src/core/service";

describe("Redis Dependency", () => {
  let service: Service<{}>;

  beforeAll(async () => {
    service = new Service()
      .withName("admin-service")
      .withPort(3103)
      .withRedis("redis://localhost:6379")
      .build();
  });

  it("Should not throw an error when accessing redis", () => {
    expect(() => service.redis).not.toThrow();
  });

  it.skip("Should automatically register the service to redis", async () => {
    const value = await service.redis.get("services:registry:admin-service");
    expect(value).toBeDefined();
    const parsedValue = JSON.parse(value!);
    expect(parsedValue.name).equal("admin-service");
    expect(parsedValue.streamKey).equal("admin:events");
    expect(parsedValue.url).equal("http://admin-service:3103");
    expect(parsedValue.dependencies).toEqual([]);
    expect(parsedValue.routes).toBeInstanceOf(Array);
    expect(
      parsedValue.routes.some(
        (s: any) => s.method === "GET" && s.path === "/health",
      ),
    ).toBeTruthy();
    expect(parsedValue.routes.length).toBeGreaterThan(0);
    expect(parsedValue.lastHeartbeat).toBeDefined();
  });
});
