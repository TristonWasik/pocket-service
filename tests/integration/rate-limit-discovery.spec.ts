/// <reference types="vitest/globals" />
import { randomBytes } from "crypto";
import { Service } from "../../src/core/service";
import { createMetaRouter } from "../../src/api/express-types";

const REDIS_URL = "redis://localhost:6379";

function limitedRouter() {
  const { router, routes, addRoute } = createMetaRouter();
  addRoute(
    { method: "GET", fullPath: "/login", meta: { rateLimit: "strict" } },
    (_, res) => {
      res.json({ ok: true });
    },
  );
  addRoute({ method: "GET", fullPath: "/free" }, (_, res) => {
    res.json({ ok: true });
  });
  addRoute(
    {
      method: "GET",
      fullPath: "/old",
      meta: { deprecated: new Date("2026-01-01T00:00:00Z") },
    },
    (_, res) => {
      res.json({ ok: true });
    },
  );
  return { router, routes };
}

describe("Rate limiting", () => {
  const services: Service<any, any>[] = [];
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.shutdown()));
  });

  it("shares limits across instances through Redis", async () => {
    const name = `rl-${randomBytes(3).toString("hex")}`;
    for (const port of [4160, 4161]) {
      const { router, routes } = limitedRouter();
      services.push(
        await new Service()
          .withName(name)
          .withPort(port)
          .withRedis(REDIS_URL)
          .withRateLimits({ strict: { limit: 2, windowMs: 60_000 } })
          .addRouter("/api", router, routes)
          .build(),
      );
    }

    const first = await fetch("http://localhost:4160/api/login");
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");

    expect((await fetch("http://localhost:4161/api/login")).status).toBe(200);

    const blocked = await fetch("http://localhost:4160/api/login");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).message).toBe("Too many requests");

    const free = await fetch("http://localhost:4160/api/free");
    expect(free.status).toBe(200);
    expect(free.headers.get("ratelimit-limit")).toBeNull();
  });

  it("falls back to per-process limits without Redis", async () => {
    const { router, routes } = limitedRouter();
    services.push(
      await new Service()
        .withName("rl-memory")
        .withPort(4162)
        .withRateLimits({
          strict: { limit: 1, windowMs: 60_000 },
          default: "strict",
        })
        .addRouter("/api", router, routes)
        .build(),
    );

    expect((await fetch("http://localhost:4162/api/free")).status).toBe(200);
    expect((await fetch("http://localhost:4162/api/free")).status).toBe(429);
  });

  it("sends a Deprecation header and serves the OpenAPI document", async () => {
    const { router, routes } = limitedRouter();
    services.push(
      await new Service()
        .withName("docs")
        .withPort(4163)
        .withOpenApi({ info: { version: "2.0.0" } })
        .addRouter("/api", router, routes)
        .build(),
    );

    const old = await fetch("http://localhost:4163/api/old");
    expect(old.headers.get("deprecation")).toBe("@1767225600");

    const doc = await (await fetch("http://localhost:4163/openapi.json")).json();
    expect(doc.info).toEqual({ title: "docs", version: "2.0.0" });
    expect(doc.paths["/api/old"].get.deprecated).toBe(true);
    expect(doc.paths["/api/login"].get.responses).toHaveProperty("429");
    expect(doc.paths).toHaveProperty("/health/ready");
  });
});

describe("Service discovery", () => {
  let gateway: Service;
  let billing: Service;
  const suffix = randomBytes(3).toString("hex");
  const billingName = `billing${suffix}-service`;

  beforeAll(async () => {
    const billingRoutes = createMetaRouter();
    billingRoutes.addRoute({ method: "GET", fullPath: "/echo" }, (req, res) => {
      res.json({
        requestId: req.id,
        authorization: req.get("authorization") ?? null,
      });
    });
    billing = await new Service()
      .withName(billingName)
      .withPort(4170)
      .withRedis(REDIS_URL)
      .addRouter("/api", billingRoutes.router, billingRoutes.routes)
      .build();

    const gatewayRoutes = createMetaRouter();
    gatewayRoutes.addRoute(
      { method: "GET", fullPath: "/proxy" },
      async (req, res) => {
        const upstream = await gateway.discovery.fetch(
          `billing${suffix}`,
          "/api/echo",
          {},
          { forward: req },
        );
        res.json(await upstream.json());
      },
    );
    gatewayRoutes.addRoute({ method: "GET", fullPath: "/missing" }, async () => {
      await gateway.discovery.fetch("nonexistent", "/");
    });
    gateway = await new Service()
      .withName(`gateway${suffix}`)
      .withPort(4171)
      .withRedis(REDIS_URL)
      .addRouter("/api", gatewayRoutes.router, gatewayRoutes.routes)
      .build();
  });

  afterAll(async () => {
    await gateway.shutdown();
    await billing.shutdown();
  });

  it("lists registered services", async () => {
    const names = (await gateway.discovery.list()).map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([billingName, `gateway${suffix}`]),
    );
  });

  it("finds a service by simple name", async () => {
    const entry = await gateway.discovery.get(`billing${suffix}`);
    expect(entry?.name).toBe(billingName);
    expect(entry?.url).toBe("http://localhost:4170");
    expect(entry?.routes.some((r) => r.path === "/api/echo")).toBe(true);
  });

  it("calls another service, forwarding auth and the request ID", async () => {
    const res = await fetch("http://localhost:4171/api/proxy", {
      headers: { "x-request-id": "trace-777", authorization: "Bearer abc" },
    });

    expect(await res.json()).toEqual({
      requestId: "trace-777",
      authorization: "Bearer abc",
    });
  });

  it("returns 503 for services that are not registered", async () => {
    const res = await fetch("http://localhost:4171/api/missing");
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("SERVICE_UNAVAILABLE");
  });
});
