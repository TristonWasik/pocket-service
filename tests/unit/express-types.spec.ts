/// <reference types="vitest/globals" />
import type { Request } from "express";
import z from "zod";
import {
  createAuthResolver,
  createMetaRouter,
  defaultHeaderAuthResolver,
} from "../../src/api/express-types";

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe("express-types", () => {
  it("reads user from x-user-meta header when valid JSON is provided", () => {
    const req = {
      headers: {
        "x-user-meta": JSON.stringify({ userId: "user-1", role: "admin" }),
      },
    } as unknown as Request;

    expect(defaultHeaderAuthResolver(req)).toEqual({
      userId: "user-1",
      role: "admin",
    });
  });

  it("returns null when x-user-meta is invalid JSON", () => {
    const req = {
      headers: {
        "x-user-id": "user-1",
        "x-user-meta": "{invalid-json",
      },
    } as unknown as Request;

    expect(defaultHeaderAuthResolver(req)).toBeNull();
  });

  it("falls back to x-user-id header when x-user-meta is not set", () => {
    const req = {
      headers: { "x-user-id": "user-2" },
    } as unknown as Request;

    expect(defaultHeaderAuthResolver(req)).toEqual({ userId: "user-2" });
  });

  it("uses auth strategies in order and then fallback resolver", async () => {
    const authResolver = createAuthResolver(
      [
        {
          name: "first",
          canHandle: async () => false,
          authenticate: async () => ({ userId: "ignored" }),
        },
        {
          name: "second",
          authenticate: async () => null,
        },
      ],
      {
        fallbackResolver: async () => ({ userId: "fallback" }),
      },
    );

    await expect(
      authResolver({ headers: {} } as unknown as Request, {
        method: "GET",
        fullPath: "/",
        requireAuth: true,
      }),
    ).resolves.toEqual({ userId: "fallback" });
  });

  it("returns route metadata from createMetaRouter", () => {
    const { routes, addRoute } = createMetaRouter();

    addRoute(
      {
        method: "POST",
        fullPath: "/items/:id",
        requireAuth: true,
        bodyValidator: z.object({ name: z.string() }),
        paramsValidator: z.object({ id: z.string() }),
        meta: { description: "Create item" },
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: "POST",
      fullPath: "/items/:id",
      requireAuth: true,
      meta: { description: "Create item" },
    });
  });

  it("returns 401 for protected route when auth resolver returns null", async () => {
    const { router, addRoute } = createMetaRouter({
      authResolver: async () => null,
    });

    addRoute(
      {
        method: "POST",
        fullPath: "/secure",
        requireAuth: true,
        bodyValidator: z.object({ name: z.string() }),
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/secure",
    );
    const authMiddleware = layer.route.stack[0].handle;

    const req = { headers: {}, body: { name: "a" } } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn();

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ isSuccess: false, message: "Unauthorized" });
  });

  it("runs auth middleware before body validation on protected routes", async () => {
    const { router, addRoute } = createMetaRouter({
      authResolver: async () => null,
    });

    addRoute(
      {
        method: "POST",
        fullPath: "/secure-order",
        requireAuth: true,
        bodyValidator: z.object({ count: z.number() }),
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/secure-order",
    );

    expect(layer.route.stack).toHaveLength(3);

    const authMiddleware = layer.route.stack[0].handle;
    const bodyMiddleware = layer.route.stack[1].handle;
    const bodyMiddlewareSpy = vi.fn(bodyMiddleware);
    const req = { headers: {}, body: "{not-json" } as unknown as Request;
    const res = createMockResponse();

    await authMiddleware(req, res, bodyMiddlewareSpy);

    expect(bodyMiddlewareSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect((res.body as any).message).toBe("Unauthorized");
  });

  it("uses custom onUnauthorized handler when auth fails", async () => {
    const onUnauthorized = vi.fn((_: Request, res: any) => {
      res.status(403).json({ denied: true });
    });

    const { router, addRoute } = createMetaRouter({
      authResolver: async () => null,
      onUnauthorized,
    });

    addRoute(
      {
        method: "GET",
        fullPath: "/custom-unauthorized",
        requireAuth: true,
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/custom-unauthorized",
    );
    const authMiddleware = layer.route.stack[0].handle;
    const res = createMockResponse();

    await authMiddleware({ headers: {} } as Request, res as any, vi.fn());

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ denied: true });
  });

  it("uses custom onAuthError handler when auth resolver throws", async () => {
    const onAuthError = vi.fn((err: unknown, _: Request, res: any) => {
      res.status(500).json({
        authError: err instanceof Error ? err.message : "unknown",
      });
    });

    const { router, addRoute } = createMetaRouter({
      authResolver: async () => {
        throw new Error("resolver exploded");
      },
      onAuthError,
    });

    addRoute(
      {
        method: "GET",
        fullPath: "/custom-auth-error",
        requireAuth: true,
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/custom-auth-error",
    );
    const authMiddleware = layer.route.stack[0].handle;
    const res = createMockResponse();
    const next = vi.fn();

    await authMiddleware({ headers: {} } as Request, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(onAuthError).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ authError: "resolver exploded" });
  });

  it("parses JSON body string when object schema is used", () => {
    const { router, addRoute } = createMetaRouter();

    addRoute(
      {
        method: "POST",
        fullPath: "/body",
        bodyValidator: z.object({ count: z.number() }),
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/body",
    );
    const bodyMiddleware = layer.route.stack[0].handle;

    const req = { body: '{"count":1}' } as Request;
    const res = createMockResponse();
    const next = vi.fn();

    bodyMiddleware(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ count: 1 });
  });

  it("returns 400 for invalid JSON body string", () => {
    const { router, addRoute } = createMetaRouter();

    addRoute(
      {
        method: "POST",
        fullPath: "/invalid-body",
        bodyValidator: z.object({ count: z.number() }),
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/invalid-body",
    );
    const bodyMiddleware = layer.route.stack[0].handle;

    const req = { body: "{bad" } as Request;
    const res = createMockResponse();
    const next = vi.fn();

    bodyMiddleware(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect((res.body as any).message).toBe("Invalid JSON in request body");
  });

  it("returns 400 when params validation fails", () => {
    const { router, addRoute } = createMetaRouter();

    addRoute(
      {
        method: "GET",
        fullPath: "/items/:id",
        paramsValidator: z.object({ id: z.uuid() }),
      },
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/items/:id",
    );
    const paramsMiddleware = layer.route.stack[0].handle;

    const req = { params: { id: "not-a-uuid" } } as unknown as Request;
    const res = createMockResponse();
    const next = vi.fn();

    paramsMiddleware(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect((res.body as any).message).toBe("Invalid URL parameters");
  });
});
