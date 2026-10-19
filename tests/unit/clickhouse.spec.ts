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
} from "../../src/modules/clickhouse";

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
      query:
        "SELECT * FROM `events` WHERE `type` = {p0:String} AND `severity` = {p1:Int64}",
      query_params: { p0: "login", p1: 2 },
    });
    expect(rows).toEqual([{ id: "1", type: "login", severity: 2 }]);
  });

  it("rejects filters on columns that are not in the schema", async () => {
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

    await expect(
      clickhouse.events.select({ "type = '' OR 1=1 --": "x" } as any),
    ).rejects.toThrow("Unknown ClickHouse column");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("sends hostile filter values as parameters, never in the SQL", async () => {
    queryMock.mockResolvedValue({ json: async () => ({ data: [] }) });
    const clickhouse = createTypedClickhouse({
      url: "http://localhost:8123",
      tables: {
        events: {
          name: "events",
          createSQL: "CREATE TABLE events (...)",
          schema: () => ({ id: "", type: "", at: new Date(0), deleted: false }),
        },
      },
    });
    const at = new Date("2026-01-01T00:00:00Z");

    await clickhouse.events.select({
      type: "\\' OR 1=1 --",
      at,
      deleted: true,
      id: null as any,
    });

    const { query, query_params } = queryMock.mock.calls[0][0];
    expect(query).toBe(
      "SELECT * FROM `events` WHERE `type` = {p0:String} AND `at` = {p1:DateTime64(3)} AND `deleted` = {p2:Bool} AND `id` IS NULL",
    );
    expect(query).not.toContain("OR 1=1");
    expect(query_params).toEqual({ p0: "\\' OR 1=1 --", p1: at, p2: true });
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
              sql: "SELECT * FROM events WHERE type = {type:String}",
            }),
          }),
        },
      },
    });

    const rows = await clickhouse.events.byType({ type: "login" });

    expect(queryMock).toHaveBeenCalledWith({
      query: "SELECT * FROM events WHERE type = {type:String}",
      query_params: { type: "login" },
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
              sql: "ALTER TABLE events DELETE WHERE id < {before:String}",
              mode: "command",
              transform: () => ({ ok: true }),
            }),
          }),
        },
      },
    });

    const result = await clickhouse.events.deleteBefore({ before: "100" });

    expect(commandMock).toHaveBeenCalledWith({
      query: "ALTER TABLE events DELETE WHERE id < {before:String}",
      query_params: { before: "100" },
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
              sql: "SELECT * FROM events WHERE type = {type:String}",
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
