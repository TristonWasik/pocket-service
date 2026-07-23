/// <reference types="vitest/globals" />
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMock = vi.fn();
const queryMock = vi.fn();
const insertMock = vi.fn();
const closeMock = vi.fn();

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn(() => ({
    command: commandMock,
    query: queryMock,
    insert: insertMock,
    close: closeMock,
  })),
}));

import {
  createTypedClickhouse,
  defineClickhouseMethod,
} from "../src/workers/db/clickhouse";

describe("Clickhouse wrapper", () => {
  beforeEach(() => {
    commandMock.mockReset();
    queryMock.mockReset();
    insertMock.mockReset();
    closeMock.mockReset();
  });

  it("executes createSQL for every configured table", async () => {
    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "" }),
        },
        metrics: {
          name: "metrics",
          createSQL: "CREATE TABLE metrics (...)",
          schema: () => ({ id: "", value: 0 }),
        },
      },
    });

    await clickhouse.ensureTables();

    expect(commandMock).toHaveBeenCalledTimes(2);
    expect(commandMock).toHaveBeenNthCalledWith(1, {
      query: "CREATE TABLE events (...)",
    });
    expect(commandMock).toHaveBeenNthCalledWith(2, {
      query: "CREATE TABLE metrics (...)",
    });
  });

  it("builds SELECT query with filters and returns parsed rows", async () => {
    queryMock.mockResolvedValue({
      json: async () => ({
        data: [{ id: "1", type: "login", severity: 2 }],
      }),
    });

    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "", severity: 0 }),
        },
      },
    });

    const rows = await clickhouse.events.select({ type: "login", severity: 2 });

    expect(queryMock).toHaveBeenCalledWith({
      query: "SELECT * FROM events WHERE type = 'login' AND severity = 2",
    });
    expect(rows).toEqual([{ id: "1", type: "login", severity: 2 }]);
  });

  it("inserts rows using JSONEachRow format", async () => {
    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "" }),
        },
      },
    });

    await clickhouse.events.insert([{ id: "1", type: "login" }]);

    expect(insertMock).toHaveBeenCalledWith({
      table: "events",
      values: [{ id: "1", type: "login" }],
      format: "JSONEachRow",
    });
  });

  it("supports custom query methods with named input params", async () => {
    queryMock.mockResolvedValue({
      json: async () => ({
        data: [{ id: "1", type: "login" }],
      }),
    });

    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "" }),
          methods: () => ({
            byType: defineClickhouseMethod<{ type: string }>({
              sql: "SELECT * FROM events WHERE type = :type",
            }),
          }),
        },
      },
    });

    const rows = await clickhouse.events.byType({ type: "login" });

    expect(queryMock).toHaveBeenCalledWith({
      query: "SELECT * FROM events WHERE type = 'login'",
    });
    expect(rows).toEqual([{ id: "1", type: "login" }]);
  });

  it("supports custom command methods and result transforms", async () => {
    commandMock.mockResolvedValue({});

    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "" }),
          methods: () => ({
            deleteBefore: defineClickhouseMethod<
              { before: string },
              { ok: true }
            >({
              sql: "ALTER TABLE events DELETE WHERE id < :before",
              mode: "command",
              transform: () => ({ ok: true }),
            }),
          }),
        },
      },
    });

    const result = await clickhouse.events.deleteBefore({ before: "100" });

    expect(commandMock).toHaveBeenCalledWith({
      query: "ALTER TABLE events DELETE WHERE id < '100'",
    });
    expect(result).toEqual({ ok: true });
  });

  it("throws for missing named params in custom methods", async () => {
    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "" }),
          methods: () => ({
            byType: defineClickhouseMethod<{ type: string }>({
              sql: "SELECT * FROM events WHERE type = :type",
            }),
          }),
        },
      },
    });

    await expect(
      clickhouse.events.byType({} as { type: string }),
    ).rejects.toThrow("Missing ClickHouse method input parameter: type");
  });

  it("infers strongly typed custom method inputs and outputs", () => {
    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "" }),
          methods: () => ({
            byType: defineClickhouseMethod<
              { type: string },
              Array<{ id: string; type: string }>
            >({
              sql: "SELECT id, type FROM events WHERE type = :type",
            }),
            ping: defineClickhouseMethod<void, { ok: true }>({
              sql: "SELECT 1",
              transform: () => ({ ok: true }),
            }),
          }),
        },
      },
    });

    expectTypeOf(clickhouse.events.byType).toEqualTypeOf<
      (input: { type: string }) => Promise<Array<{ id: string; type: string }>>
    >();
    expectTypeOf(clickhouse.events.ping).toEqualTypeOf<
      () => Promise<{ ok: true }>
    >();
  });
});
