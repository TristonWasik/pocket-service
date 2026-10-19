/// <reference types="vitest/globals" />
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, RedisClientType } from "redis";

// Worker threads only run from the built package, so this suite exercises
// dist/ exactly as a consumer of the published package would.
const distEntry = fileURLToPath(new URL("../../dist/index.mjs", import.meta.url));
const handlersDir = fileURLToPath(
  new URL("../fixtures/handlers", import.meta.url),
);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const PORT = 4320;
const auth = { "x-user-id": "tester" };

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      // service not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Worker threads (built package)", () => {
  let admin: RedisClientType;
  let service: any;
  const stream = `wt${randomBytes(4).toString("hex")}:events`;
  const base = `http://localhost:${PORT}/workers`;

  beforeAll(async () => {
    if (!existsSync(distEntry)) {
      throw new Error("dist/ not found. Run `pnpm build` before this suite.");
    }
    const { Service } = await import(distEntry);

    admin = createClient({ url: REDIS_URL });
    await admin.connect();

    service = new Service()
      .withName(`wt-${randomBytes(3).toString("hex")}`)
      .withPort(PORT)
      .withRedis(REDIS_URL)
      .withWorkers(2, [stream], {
        handlersDir: path.resolve(handlersDir),
        maxRetries: 2,
        retryBackoffMs: 1,
        blockMs: 200,
      })
      .build();

    await waitFor(async () => {
      const res = await fetch(base, { headers: auth });
      const body = await res.json();
      return body.workers.filter((w: any) => w.state === "running").length === 2;
    });
  });

  afterAll(async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as any);
    await service?.shutdown();
    exitSpy.mockRestore();
    await admin.del([stream, `dlq:${stream}`, `${stream}:seen`]);
    await admin.close();
  });

  it("reports loaded handlers", async () => {
    const body = await (await fetch(base, { headers: auth })).json();
    expect(body.status).toBe("Running");
    expect(body.handlersLoaded.sort()).toEqual(["wt:fail", "wt:record"]);
  });

  it("processes every message across workers without leaving pending entries", async () => {
    for (let n = 0; n < 50; n++) {
      await admin.xAdd(stream, "*", { eventType: "wt:record", n: String(n) });
    }

    await waitFor(async () => (await admin.lLen(`${stream}:seen`)) === 50);
    const res = await fetch(`${base}/${stream}/pending`, { headers: auth });
    expect((await res.json()).pending.pending).toBe(0);
  });

  it("dead-letters failures and retries them from the DLQ route", async () => {
    await admin.xAdd(stream, "*", { eventType: "wt:fail" });

    let dlqId = "";
    await waitFor(async () => {
      const res = await fetch(`${base}/${stream}/dlq`, { headers: auth });
      const { messages } = await res.json();
      dlqId = messages[0]?.id ?? "";
      return dlqId !== "";
    });

    const retry = await fetch(`${base}/${stream}/dlq/${dlqId}/retry`, {
      method: "POST",
      headers: auth,
    });
    expect(retry.status).toBe(200);
    expect(await admin.xRange(`dlq:${stream}`, dlqId, dlqId)).toEqual([]);
  });

  it("rejects streams the service does not subscribe to", async () => {
    const res = await fetch(`${base}/other:events`, { headers: auth });
    expect(res.status).toBe(404);
  });

  it("stops workers on shutdown", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as any);
    await service.shutdown();
    exitSpy.mockRestore();
    expect(service.status).toBe("stopped");
    service = null;
  });
});
