/// <reference types="vitest/globals" />
import { Service } from "../../src/core/service";

describe("Worker route auth integration", () => {
  const services: Service[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.shutdown()));
  });

  it("allows /workers with default header auth fallback when x-user-id is present", async () => {
    const port = 4310;
    const service = await new Service()
      .withName("worker-auth-default")
      .withPort(port)
      .withRedis("redis://localhost:6379")
      .withWorkers(1, ["auth:events"])
      .build();
    services.push(service);

    expect(() => service.redis).not.toThrow();


    const unauthorized = await fetch(`http://localhost:${port}/workers`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`http://localhost:${port}/workers`, {
      headers: {
        "x-user-id": "user-123",
      },
    });

    expect(authorized.status).toBe(200);
    const body = await authorized.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("handlersLoaded");
  });

  it("rejects /workers when default header auth fallback is disabled", async () => {
    const port = 4311;
    const service = await new Service()
      .withName("worker-auth-disabled")
      .withPort(port)
      .withRedis("redis://localhost:6379")
      .withWorkers(1, ["auth:events"])
      .withoutDefaultHeaderAuthFallback()
      .build();
    services.push(service);

    expect(() => service.redis).not.toThrow();


    const headerOnly = await fetch(`http://localhost:${port}/workers`, {
      headers: {
        "x-user-id": "user-456",
      },
    });

    expect(headerOnly.status).toBe(401);
  });
});
