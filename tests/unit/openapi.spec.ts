/// <reference types="vitest/globals" />
import { compileErrors, validate } from "@readme/openapi-parser";
import z from "zod";
import { createMetaRouter } from "../../src/api/express-types";
import { buildOpenApiDocument } from "../../src/api/openapi";

function makeRouters() {
  const users = createMetaRouter();
  users.addRoute(
    {
      method: "GET",
      fullPath: "/:id",
      requireAuth: true,
      paramsValidator: z.object({ id: z.uuid() }),
      meta: {
        description: "Get a user",
        tags: ["users"],
        operationId: "getUser",
      },
    },
    () => {},
  );
  users.addRoute(
    {
      method: "GET",
      fullPath: "/",
      queryValidator: z.object({
        q: z.string(),
        limit: z.coerce.number().int().default(10),
      }),
      meta: { rateLimit: "strict", deprecated: true },
    },
    () => {},
  );
  users.addRoute(
    {
      method: "POST",
      fullPath: "/",
      bodyValidator: z.object({
        email: z.email(),
        createdAt: z.date().optional(),
      }),
    },
    () => {},
  );

  const misc = createMetaRouter();
  misc.addRoute({ method: "DELETE", fullPath: "/items/:itemId" }, () => {});

  return [
    { base: "/users", routes: users.routes },
    { base: "/", routes: misc.routes },
  ];
}

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument(makeRouters(), {
    defaultTitle: "users-service",
    info: { version: "2.0.0" },
  }) as any;

  it("produces a valid OpenAPI 3.1 document", async () => {
    const result = await validate(structuredClone(doc));
    expect(result.valid, compileErrors(result)).toBe(true);
  });

  it("uses the service name and given version", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "users-service", version: "2.0.0" });
  });

  it("converts Express paths and documents path params", () => {
    const op = doc.paths["/users/{id}"].get;
    expect(op.operationId).toBe("getUser");
    expect(op.tags).toEqual(["users"]);
    expect(op.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path", required: true }),
    ]);
    expect(op.parameters[0].schema.format).toBe("uuid");
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401"]);
  });

  it("documents query params with optional defaults", () => {
    const op = doc.paths["/users"].get;
    const params = Object.fromEntries(
      op.parameters.map((p: any) => [p.name, p]),
    );
    expect(params.q).toMatchObject({ in: "query", required: true });
    expect(params.limit).toMatchObject({ in: "query", required: false });
    expect(op.deprecated).toBe(true);
    expect(op.responses).toHaveProperty("429");
  });

  it("documents JSON request bodies, tolerating unrepresentable types", () => {
    const body = doc.paths["/users"].post.requestBody;
    expect(body.required).toBe(true);
    expect(body.content["application/json"].schema).toMatchObject({
      type: "object",
      required: ["email"],
    });
  });

  it("adds string path params for routes without a params validator", () => {
    expect(doc.paths["/items/{itemId}"].delete.parameters).toEqual([
      { name: "itemId", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("only includes security schemes when a route requires auth", () => {
    expect(doc.components.securitySchemes).toHaveProperty("bearerAuth");
    const publicOnly = buildOpenApiDocument(
      [{ base: "/", routes: makeRouters()[1].routes }],
      { defaultTitle: "x" },
    ) as any;
    expect(publicOnly.components.securitySchemes).toBeUndefined();
  });
});
