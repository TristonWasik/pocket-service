import type { Request } from "express";
import type { RedisClientType } from "redis";
import { HttpError } from "../api/errors";
import type { AnyRouteDefinition } from "../api/express-types";

export const REGISTRY_PREFIX = "services:registry:";

/** What each service writes to the registry on every heartbeat. */
export type ServiceRegistration = {
  name: string;
  streamKey: string;
  url: string;
  dependencies: string[];
  routes: {
    path: string;
    method: AnyRouteDefinition["method"];
    requireAuth: boolean;
    meta: AnyRouteDefinition["meta"];
  }[];
  lastHeartbeat: number;
};

export type DiscoveryFetchOptions = {
  /**
   * Incoming request whose `authorization` header and request ID are copied
   * to the outgoing request, unless already set in `init.headers`.
   */
  forward?: Request;
};

const FORWARDED_HEADERS = ["authorization"];

/**
 * Reads the service registry that every service with Redis maintains.
 * Lookups are cached for `cacheMs` (the heartbeat interval by default).
 */
export function createDiscovery(redis: RedisClientType, cacheMs = 5_000) {
  let cache: { at: number; entries: ServiceRegistration[] } | null = null;

  async function load(): Promise<ServiceRegistration[]> {
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({
      MATCH: `${REGISTRY_PREFIX}*`,
      COUNT: 100,
    })) {
      keys.push(...(Array.isArray(batch) ? batch : [batch]));
    }
    if (keys.length === 0) return [];

    const values = await redis.mGet(keys);
    const entries = values.flatMap((value) => {
      if (!value) return [];
      try {
        return [JSON.parse(value) as ServiceRegistration];
      } catch {
        return [];
      }
    });
    cache = { at: Date.now(), entries };
    return entries;
  }

  /** Every registered service. */
  async function list({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < cacheMs) {
      return cache.entries;
    }
    return load();
  }

  const find = (entries: ServiceRegistration[], name: string) =>
    entries.find((s) => s.name === name) ??
    entries.find((s) => s.name.split("-")[0] === name) ??
    null;

  /**
   * A service by exact name, or by simple name (`"auth"` finds
   * `"auth-service"`). Misses bypass the cache once, to pick up services
   * that registered since the last lookup.
   */
  async function get(name: string): Promise<ServiceRegistration | null> {
    return find(await list(), name) ?? find(await list({ fresh: true }), name);
  }

  /**
   * Calls another service by name. Throws `HttpError(503)` when it is not
   * registered.
   *
   * @example
   * const res = await service.discovery.fetch("billing", "/api/invoices", {}, { forward: req });
   */
  async function fetchService(
    name: string,
    path: string,
    init: RequestInit = {},
    options: DiscoveryFetchOptions = {},
  ): Promise<Response> {
    const target = await get(name);
    if (!target) {
      throw new HttpError(503, `Service "${name}" is not registered`, {
        code: "SERVICE_UNAVAILABLE",
      });
    }

    const headers = new Headers(init.headers);
    const incoming = options.forward;
    if (incoming) {
      for (const header of FORWARDED_HEADERS) {
        const value = incoming.get(header);
        if (value && !headers.has(header)) headers.set(header, value);
      }
      const requestId = incoming.id ?? incoming.get("x-request-id");
      if (requestId && !headers.has("x-request-id")) {
        headers.set("x-request-id", requestId);
      }
    }

    return fetch(new URL(path, target.url), { ...init, headers });
  }

  return { list, get, fetch: fetchService };
}

export type Discovery = ReturnType<typeof createDiscovery>;
