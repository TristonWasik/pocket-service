import { createClient } from "@clickhouse/client";

type AnyClickhouseMethod = ClickhouseMethodDefinition<any, any>;

export type ClickhouseMethodMode = "query" | "command";

export type ClickhouseMethodDefinition<
  TInput extends Record<string, any> | void = void,
  TResult = any[],
> = {
  /**
   * SQL statement using ClickHouse query parameters, e.g.
   * `SELECT * FROM events WHERE type = {type:String}`. Each input field is
   * sent as a server-side parameter, never interpolated into the SQL.
   */
  sql: string;
  /**
   * Defaults to `query` and returns parsed rows from ClickHouse.
   */
  mode?: ClickhouseMethodMode;
  /**
   * Optional result mapper for shaping the output.
   */
  transform?: (result: unknown, input: TInput) => TResult;
};

export type ClickhouseTableMethods = Record<string, AnyClickhouseMethod>;

export type ClickhouseMethodContext<TSchema extends Record<string, any>> = {
  client: ReturnType<typeof createClient>;
  table: string;
  schema: () => TSchema;
};

export interface ClickhouseTable<
  TSchema extends Record<string, any>,
  TMethods extends ClickhouseTableMethods = {},
> {
  name: string;
  createSQL: string;
  schema: () => TSchema;
  methods?: (ctx: ClickhouseMethodContext<TSchema>) => TMethods;
}

export interface ClickhouseConfig<
  TTables extends Record<string, ClickhouseTable<any, ClickhouseTableMethods>>,
> {
  url: string;
  username?: string;
  password?: string;
  tables: TTables;
}

type ResolveClickhouseMethod<TMethod extends AnyClickhouseMethod> =
  TMethod extends ClickhouseMethodDefinition<infer TInput, infer TResult>
    ? TInput extends void
      ? () => Promise<TResult>
      : (input: TInput) => Promise<TResult>
    : never;

type InferClickhouseMethods<TTable> = TTable extends {
  methods?: (...args: any[]) => infer TMethods;
}
  ? TMethods extends ClickhouseTableMethods
    ? {
        [K in keyof TMethods]: ResolveClickhouseMethod<TMethods[K]>;
      }
    : {}
  : {};

export function defineClickhouseMethod<
  TInput extends Record<string, any> | void = void,
  TResult = any[],
>(
  config: ClickhouseMethodDefinition<TInput, TResult>,
): ClickhouseMethodDefinition<TInput, TResult> {
  return config;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Backtick-quotes a (possibly database-qualified) identifier, rejecting
 * anything that is not a plain identifier.
 */
function quoteIdentifier(name: string): string {
  return name
    .split(".")
    .map((part) => {
      if (!IDENTIFIER.test(part)) {
        throw new Error(`Invalid ClickHouse identifier: ${name}`);
      }
      return `\`${part}\``;
    })
    .join(".");
}

/**
 * Infers the ClickHouse type used for a `select()` filter parameter.
 */
function paramType(value: unknown): string {
  if (typeof value === "string") return "String";
  if (typeof value === "bigint") return "Int64";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "Int64" : "Float64";
  }
  if (typeof value === "boolean") return "Bool";
  if (value instanceof Date) return "DateTime64(3)";
  if (Array.isArray(value)) {
    return `Array(${value.length > 0 ? paramType(value[0]) : "String"})`;
  }
  throw new Error(`Unsupported ClickHouse filter value: ${String(value)}`);
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*):/g;

/**
 * Names of the `{name:Type}` parameters referenced by a SQL statement.
 */
export function queryParamNames(sql: string): string[] {
  return [...new Set([...sql.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/**
 * Builds a parameterized WHERE clause. Column names must exist in the table
 * schema; values are sent as query parameters.
 */
export function buildWhereClause(
  where: Record<string, unknown> | undefined,
  columns: Set<string>,
): { clause: string; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(where ?? {})) {
    if (!columns.has(column)) {
      throw new Error(`Unknown ClickHouse column: ${column}`);
    }
    if (value === undefined) continue;

    const id = quoteIdentifier(column);
    if (value === null) {
      conditions.push(`${id} IS NULL`);
      continue;
    }
    const name = `p${conditions.length}`;
    params[name] = value;
    conditions.push(`${id} = {${name}:${paramType(value)}}`);
  }

  return {
    clause: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export function createTypedClickhouse<
  TTables extends Record<string, ClickhouseTable<any, ClickhouseTableMethods>>,
>(config: ClickhouseConfig<TTables>) {
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
  });

  async function ensureTables() {
    for (const { createSQL } of Object.values(config.tables || {})) {
      await client.command({ query: createSQL });
    }
  }

  const api = Object.fromEntries(
    Object.entries(config.tables || {}).map(([key, table]) => {
      type Row = ReturnType<typeof table.schema>;
      type Filter = Partial<Row>;

      const columns = new Set(Object.keys(table.schema()));

      const select = async (where?: Filter): Promise<Row[]> => {
        const { clause, params } = buildWhereClause(where, columns);
        const res = await client.query({
          query: `SELECT * FROM ${quoteIdentifier(table.name)}${clause}`,
          query_params: params,
        });
        const rows = await res.json<{ data: any[] }>();
        return rows.data as Row[];
      };

      const insert = async (rows: Row[]) => {
        await client.insert({
          table: table.name,
          values: rows,
          format: "JSONEachRow",
        });
      };

      const customMethodDefinitions =
        table.methods?.({
          client,
          table: table.name,
          schema: table.schema,
        }) || {};

      const customMethods = Object.fromEntries(
        Object.entries(customMethodDefinitions).map(([methodName, def]) => {
          const paramNames = queryParamNames(def.sql);
          const method = async (input?: Record<string, unknown>) => {
            const query = def.sql;
            const query_params = input ?? {};
            for (const name of paramNames) {
              if (!(name in query_params)) {
                throw new Error(
                  `Missing ClickHouse method input parameter: ${name}`,
                );
              }
            }

            if (def.mode === "command") {
              const result = await client.command({ query, query_params });
              return def.transform
                ? def.transform(result, input as any)
                : (undefined as any);
            }

            const result = await client.query({ query, query_params });
            const parsed = await result.json<{ data: any[] }>();

            return def.transform
              ? def.transform(parsed.data, input as any)
              : (parsed.data as any);
          };

          return [methodName, method];
        }),
      );

      return [key, { select, insert, ...customMethods }];
    }),
  ) as {
    [K in keyof TTables]: {
      select(
        where?: Partial<ReturnType<TTables[K]["schema"]>>,
      ): Promise<ReturnType<TTables[K]["schema"]>[]>;
      insert(rows: ReturnType<TTables[K]["schema"]>[]): Promise<void>;
    } & InferClickhouseMethods<TTables[K]>;
  };

  return { client, ensureTables, ...api };
}
