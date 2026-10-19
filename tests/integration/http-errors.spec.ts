/// <reference types="vitest/globals" />
import z from "zod";
import { Service } from "../../src/core/service";
import { createMetaRouter } from "../../src/api/express-types";
import { HttpError } from "../../src/api/errors";

const PORT = 4130;
const base = `http://localhost:${PORT}`;

describe("HTTP errors and request context", () => {
  let service: Service;
  let lastRequestId: string | undefined;

  beforeAll(async () => {
    const { router, routes, addRoute } = createMetaRouter();

    addRoute(
      { method: "GET", fullPath: "/missing" },
      async () => {
        throw new HttpError(404, "User not found", {
          code: "USER_NOT_FOUND",
          details: { id: "u1" },
        });
      },
    );
    addRoute({ method: "GET", fullPath: "/boom" }, async () => {
      throw new Error("database password is hunter2");
    });
    addRoute({ method: "GET", fullPath: "/whoami" }, (req, res) => {
      lastRequestId = req.id;
      req.log.info("handled");
      res.json({ id: req.id });
    });
    addRoute(
      {
        method: "GET",
        fullPath: "/search",
        queryValidator: z.object({
          q: z.string().min(1),
          limit: z.coerce.number().int().max(50).default(10),
        }),
      },
      (req, res) => {
        res.json({ q: req.query.q, limit: req.query.limit });
      },
    );
    addRoute(
      {
        method: "POST",
        fullPath: "/items",
        bodyValidator: z.object({ name: z.string() }),
      },
      (req, res) => {
        res.json({ name: req.body.name });
      },
    );

    service = await new Service()
      .withName("errors-test")
      .withPort(PORT)
      .addRouter("/api", router, routes)
      .build();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  it("sends HttpError status, message, code and details", async () => {
    const res = await fetch(`${base}/api/missing`);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      isSuccess: false,
      message: "User not found",
      code: "USER_NOT_FOUND",
      details: { id: "u1" },
      requestId: res.headers.get("x-request-id"),
    });
  });

  it("hides the message of unexpected errors", async () => {
    const res = await fetch(`${base}/api/boom`);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("returns JSON for unknown routes", async () => {
    const res = await fetch(`${base}/nope`);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      isSuccess: false,
      message: "Not found",
    });
  });

  it("returns 400 JSON for malformed JSON bodies", async () => {
    const res = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("Invalid JSON in request body");
  });

  it("returns validation issues in details", async () => {
    const res = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.message).toBe("Invalid request body");
    expect(body.details[0].path).toEqual(["name"]);
  });

  it("reuses a valid incoming request ID and echoes it", async () => {
    const res = await fetch(`${base}/api/whoami`, {
      headers: { "x-request-id": "trace-123" },
    });

    expect(res.headers.get("x-request-id")).toBe("trace-123");
    expect((await res.json()).id).toBe("trace-123");
    expect(lastRequestId).toBe("trace-123");
  });

  it("replaces an unsafe incoming request ID", async () => {
    const res = await fetch(`${base}/api/whoami`, {
      headers: { "x-request-id": "bad id\twith spaces" },
    });
    const id = res.headers.get("x-request-id");

    expect(id).not.toBe("bad id\twith spaces");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("validates and coerces the query string", async () => {
    const ok = await fetch(`${base}/api/search?q=shoes&limit=5`);
    expect(await ok.json()).toEqual({ q: "shoes", limit: 5 });

    const defaulted = await fetch(`${base}/api/search?q=shoes`);
    expect((await defaulted.json()).limit).toBe(10);

    const bad = await fetch(`${base}/api/search?limit=500`);
    const body = await bad.json();
    expect(bad.status).toBe(400);
    expect(body.message).toBe("Invalid query parameters");
    expect(body.details.map((i: any) => i.path[0]).sort()).toEqual([
      "limit",
      "q",
    ]);
  });
});
