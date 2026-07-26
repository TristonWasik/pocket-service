/// <reference types="vitest/globals" />
import { Service } from "../../src/core/service";

async function waitForHttp(url: string, timeoutMs: number = 4000) {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      await res.text();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

describe("Worker route auth integration", () => {
  it("allows /workers with default header auth fallback when x-user-id is present", async () => {
    const port = 4310;
    const service = new Service()
      .withName("worker-auth-default")
      .withPort(port)
      .withRedis("redis://localhost:6379")
      .withWorkers(1, ["auth:events"])
      .build();

    expect(() => service.redis).not.toThrow();

    await waitForHttp(`http://localhost:${port}/`);

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
    const service = new Service()
      .withName("worker-auth-disabled")
      .withPort(port)
      .withRedis("redis://localhost:6379")
      .withWorkers(1, ["auth:events"])
      .withoutDefaultHeaderAuthFallback()
      .build();

    expect(() => service.redis).not.toThrow();

    await waitForHttp(`http://localhost:${port}/`);

    const headerOnly = await fetch(`http://localhost:${port}/workers`, {
      headers: {
        "x-user-id": "user-456",
      },
    });

    expect(headerOnly.status).toBe(401);
  });
});
