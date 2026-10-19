import z, { ZodType } from "zod";
import type { AnyRouteDefinition } from "./express-types";

export type OpenApiOptions = {
  /** Where the document is served. Defaults to `/openapi.json`. */
  path?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string; description?: string }[];
  /**
   * Security schemes applied to `requireAuth` routes. Defaults to an HTTP
   * bearer scheme named `bearerAuth`.
   */
  securitySchemes?: Record<string, Record<string, unknown>>;
};

type RouterRoutes = { base: string; routes?: AnyRouteDefinition[] };
type JsonSchema = Record<string, any>;

const PATH_PARAM = /:([A-Za-z0-9_]+)/g;

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    isSuccess: { type: "boolean", const: false },
    message: { type: "string" },
    code: { type: "string" },
    details: {},
    requestId: { type: "string" },
  },
  required: ["isSuccess", "message"],
};

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
});

function toJsonSchema(schema: ZodType): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema;
  return rest;
}

/** Joins a router base and a route path the same way Express mounts them. */
export function joinRoutePath(base: string, path: string) {
  const prefix = base === "/" ? "" : base;
  const suffix = path === "/" ? "" : path;
  return `${prefix}${suffix}` || "/";
}

function parametersFromSchema(
  schema: ZodType,
  location: "path" | "query",
): JsonSchema[] {
  const json = toJsonSchema(schema);
  const required = new Set<string>(json.required ?? []);
  return Object.entries<JsonSchema>(json.properties ?? {}).map(
    ([name, propertySchema]) => ({
      name,
      in: location,
      required: location === "path" || required.has(name),
      schema: propertySchema,
    }),
  );
}

function buildOperation(route: AnyRouteDefinition, fullPath: string) {
  const meta = route.meta ?? {};
  const parameters: JsonSchema[] = route.paramsValidator
    ? parametersFromSchema(route.paramsValidator, "path")
    : [...fullPath.matchAll(PATH_PARAM)].map(([, name]) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
  if (route.queryValidator) {
    parameters.push(...parametersFromSchema(route.queryValidator, "query"));
  }

  const hasBody = Boolean(route.bodyValidator) && route.method !== "GET";
  const responses: Record<string, unknown> = {
    "200": { description: "Success" },
  };
  if (hasBody || route.paramsValidator || route.queryValidator) {
    responses["400"] = errorResponse("Invalid request");
  }
  if (route.requireAuth) {
    responses["401"] = errorResponse("Unauthorized");
  }
  if (meta.rateLimit && meta.rateLimit !== "none") {
    responses["429"] = errorResponse("Too many requests");
  }

  const operation: Record<string, unknown> = {
    summary: meta.description,
    operationId: meta.operationId,
    tags: meta.tags,
    deprecated: meta.deprecated ? true : undefined,
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody: hasBody
      ? {
          required: true,
          content: {
            "application/json": { schema: toJsonSchema(route.bodyValidator) },
          },
        }
      : undefined,
    responses,
  };
  return Object.fromEntries(
    Object.entries(operation).filter(([, value]) => value !== undefined),
  );
}

/**
 * Builds an OpenAPI 3.1 document from the routes registered with
 * `createMetaRouter()` and `addRouter()`, including their Zod validators.
 */
export function buildOpenApiDocument(
  routers: RouterRoutes[],
  options: OpenApiOptions & { defaultTitle: string },
) {
  const securitySchemes = options.securitySchemes ?? {
    bearerAuth: { type: "http", scheme: "bearer" },
  };
  const security = Object.keys(securitySchemes).map((name) => ({
    [name]: [],
  }));

  const paths: Record<string, Record<string, unknown>> = {};
  let usesAuth = false;

  for (const router of routers) {
    for (const route of router.routes ?? []) {
      const fullPath = joinRoutePath(router.base, route.fullPath);
      const operation = buildOperation(route, fullPath);
      if (route.requireAuth) {
        usesAuth = true;
        operation.security = security;
      }
      const key = fullPath.replace(PATH_PARAM, "{$1}");
      paths[key] = { ...paths[key], [route.method.toLowerCase()]: operation };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.info?.title ?? options.defaultTitle,
      version: options.info?.version ?? "1.0.0",
      ...(options.info?.description
        ? { description: options.info.description }
        : {}),
    },
    ...(options.servers ? { servers: options.servers } : {}),
    paths,
    components: {
      schemas: { Error: ERROR_SCHEMA },
      ...(usesAuth ? { securitySchemes } : {}),
    },
  };
}
