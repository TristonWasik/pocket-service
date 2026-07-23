import { createClient } from "@clickhouse/client";

type AnyClickhouseMethod = ClickhouseMethodDefinition<any, any>;

export type ClickhouseMethodMode = "query" | "command";

export type ClickhouseMethodDefinition<
  TInput extends Record<string, any> | void = void,
  TResult = any[],
> = {
  /**
   * SQL statement using named input placeholders like `:userId`.
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

function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => escapeSqlValue(v)).join(", ")}]`;
  }

  if (value instanceof Date) {
    return `'${value.toISOString().replace(/'/g, "''")}'`;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return `${value}`;
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindNamedParams(sql: string, input?: Record<string, unknown>): string {
  const params = input || {};
  return sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, key: string) => {
    if (!(key in params)) {
      throw new Error(`Missing ClickHouse method input parameter: ${key}`);
    }
    return escapeSqlValue(params[key]);
  });
}

export function createTypedClickhouse<
  TTables extends Record<string, ClickhouseTable<any, ClickhouseTableMethods>>,
>(config: ClickhouseConfig<TTables>) {
  const client = createClient({
    host: config.url,
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

      const select = async (where?: Filter): Promise<Row[]> => {
        let query = `SELECT * FROM ${table.name}`;
        if (where && Object.keys(where).length > 0) {
          const conditions = Object.entries(where)
            .map(([k, value]) => {
              if (typeof value === "string") return `${k} = '${value}'`;
              return `${k} = ${value}`;
            })
            .join(" AND ");
          query += ` WHERE ${conditions}`;
        }
        const res = await client.query({
          query,
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
          const method = async (input?: Record<string, unknown>) => {
            const query = bindNamedParams(def.sql, input);

            if (def.mode === "command") {
              const result = await client.command({ query });
              return def.transform
                ? def.transform(result, input as any)
                : (undefined as any);
            }

            const result = await client.query({ query });
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
