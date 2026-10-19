/// <reference types="vitest/globals" />
import z from "zod";
import { Service } from "../../src/core/service";

const Env = z.object({
  REDIS_URL: z.url(),
  WORKERS: z.coerce.number().int().default(2),
  DEBUG: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

describe("withEnv", () => {
  it("parses and types the environment", () => {
    const service = new Service().withEnv(Env, {
      REDIS_URL: "redis://cache:6379",
      WORKERS: "4",
    });

    expect(service.env).toEqual({
      REDIS_URL: "redis://cache:6379",
      WORKERS: 4,
      DEBUG: false,
    });
    expectTypeOf(service.env.WORKERS).toEqualTypeOf<number>();
    expectTypeOf(service.env.DEBUG).toEqualTypeOf<boolean>();
  });

  it("keeps the env type through later builder calls", () => {
    const service = new Service()
      .withEnv(Env, { REDIS_URL: "redis://cache:6379" })
      .withName("typed")
      .withMongo({ dbName: "x", collections: {} });

    expectTypeOf(service.env.REDIS_URL).toEqualTypeOf<string>();
    expect(service.env.WORKERS).toBe(2);
  });

  it("throws a readable error listing every invalid variable", () => {
    expect(() =>
      new Service().withEnv(Env, { REDIS_URL: "not a url", WORKERS: "x" }),
    ).toThrow(/Invalid environment variables:[\s\S]*REDIS_URL[\s\S]*WORKERS/);
  });

  it("throws when env is read without withEnv()", () => {
    expect(() => new Service().env).toThrow("withEnv() has not been called.");
  });
});
