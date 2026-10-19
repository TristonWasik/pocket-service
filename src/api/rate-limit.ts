import type { Request, RequestHandler } from "express";
import type { RedisClientType } from "redis";
import type { Log } from "../core/types";
import { errorBody } from "./errors";
import type { AnyRouteDefinition, AuthenticatedUser } from "./express-types";

export type RateLimitTier = "standard" | "strict";

export type RateLimitRule = {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitOptions = {
  /** Defaults to 100 requests per minute. */
  standard?: RateLimitRule;
  /** Defaults to 10 requests per minute. */
  strict?: RateLimitRule;
  /**
   * Tier for routes without `meta.rateLimit`. Defaults to `"none"`, so only
   * routes that opt in are limited.
   */
  default?: RateLimitTier | "none";
  /**
   * Identifies the caller. Defaults to the authenticated user ID, then the
   * client IP (set `trustProxy` behind a load balancer).
   */
  keyBy?: (req: Request) => string | undefined;
};

/**
 * Counts hits for a key within a fixed window and returns the new count.
 */
export type RateLimitStore = {
  hit: (key: string, windowMs: number) => Promise<number>;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
};

export type RateLimiter = {
  defaultTier: RateLimitTier | "none";
  check: (req: Request, tier: RateLimitTier) => Promise<RateLimitResult | null>;
};

/** `app.locals` key the route middleware reads the limiter from. */
export const RATE_LIMITER_KEY = "pocketRateLimiter";

const DEFAULT_RULES: Record<RateLimitTier, RateLimitRule> = {
  standard: { limit: 100, windowMs: 60_000 },
  strict: { limit: 10, windowMs: 60_000 },
};

// Increments and sets the expiry atomically, so a key can never be left
// without a TTL.
const HIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count
`;

export function createRedisRateLimitStore(
  redis: RedisClientType,
): RateLimitStore {
  return {
    async hit(key, windowMs) {
      const count = await redis.eval(HIT_SCRIPT, {
        keys: [key],
        arguments: [String(windowMs)],
      });
      return Number(count);
    },
  };
}

const MEMORY_SWEEP_THRESHOLD = 10_000;

/**
 * Per-process store, used when the service has no Redis.
 */
export function createMemoryRateLimitStore(
  now: () => number = Date.now,
): RateLimitStore {
  const counters = new Map<string, { count: number; expiresAt: number }>();

  return {
    async hit(key, windowMs) {
      const time = now();
      if (counters.size > MEMORY_SWEEP_THRESHOLD) {
        for (const [k, entry] of counters) {
          if (entry.expiresAt <= time) counters.delete(k);
        }
      }
      const entry = counters.get(key);
      if (!entry || entry.expiresAt <= time) {
        counters.set(key, { count: 1, expiresAt: time + windowMs });
        return 1;
      }
      entry.count++;
      return entry.count;
    },
  };
}

/**
 * Fixed-window rate limiter. If the store fails (for example Redis is down),
 * requests are allowed and a warning is logged, so a store outage does not
 * take the API down with it.
 */
export function createRateLimiter(cfg: {
  options: RateLimitOptions;
  store: RateLimitStore;
  prefix: string;
  log: Log;
  now?: () => number;
}): RateLimiter {
  const rules: Record<RateLimitTier, RateLimitRule> = {
    standard: cfg.options.standard ?? DEFAULT_RULES.standard,
    strict: cfg.options.strict ?? DEFAULT_RULES.strict,
  };
  const now = cfg.now ?? Date.now;

  return {
    defaultTier: cfg.options.default ?? "none",
    async check(req, tier) {
      const rule = rules[tier];
      const user = (req as Request & { user?: AuthenticatedUser }).user;
      const id =
        cfg.options.keyBy?.(req) ?? user?.userId ?? req.ip ?? "unknown";
      const time = now();
      const window = Math.floor(time / rule.windowMs);
      const key = `${cfg.prefix}:${tier}:${id}:${window}`;

      let count: number;
      try {
        count = await cfg.store.hit(key, rule.windowMs);
      } catch (err) {
        cfg.log.warn(`Rate limit store failed; allowing request: ${err}`);
        return null;
      }

      return {
        allowed: count <= rule.limit,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetSeconds: Math.ceil(((window + 1) * rule.windowMs - time) / 1000),
      };
    },
  };
}

/**
 * Applies the service's rate limiter to one route. The limiter is read from
 * `app.locals` at request time, because routers are created before the
 * service that mounts them.
 */
export function rateLimitMiddleware(route: AnyRouteDefinition): RequestHandler {
  return async (req, res, next) => {
    const limiter = req.app?.locals?.[RATE_LIMITER_KEY] as
      | RateLimiter
      | undefined;
    if (!limiter) {
      next();
      return;
    }
    const tier = route.meta?.rateLimit ?? limiter.defaultTier;
    if (tier === "none") {
      next();
      return;
    }

    const result = await limiter.check(req, tier);
    if (!result) {
      next();
      return;
    }

    res.setHeader("RateLimit-Limit", String(result.limit));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(result.resetSeconds));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.resetSeconds));
      res.status(429).json(errorBody(req, "Too many requests"));
      return;
    }
    next();
  };
}
