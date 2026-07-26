import { Collection, Db, Document, MongoClient } from "mongodb";
import { CollectionWrapper, SchemaParser } from "./collection";

type AnyMongoMethod = (...args: any[]) => any;

export type MongoCollectionMethods = Record<string, AnyMongoMethod>;

export type MongoIndexSpec = {
  /**
   * Index key specification. Example: { userId: 1 } for ascending, { userId: -1 } for descending
   */
  key: Record<string, 1 | -1>;
  /**
   * Optional name for the index. If not provided, MongoDB will auto-generate.
   */
  name?: string;
  /**
   * Whether the index should enforce uniqueness.
   */
  unique?: boolean;
  /**
   * Whether the index should be sparse (only index documents with the indexed field).
   */
  sparse?: boolean;
  /**
   * Whether to build the index in the background without blocking other operations.
   */
  background?: boolean;
  /**
   * The time-to-live (TTL) for documents in the collection, in seconds. Only applicable for TTL indexes.
   */
  expireAfterSeconds?: number;
};

export type MongoTimeSeriesSpec = {
  /**
   * Name of the date field that MongoDB uses as the event time.
   */
  timeField: string;
  /**
   * Optional metadata field used to group measurements.
   */
  metaField?: string;
  /**
   * Optional bucket granularity hint used by MongoDB.
   */
  granularity?: "seconds" | "minutes" | "hours";
  /**
   * Optional retention in seconds for automatic expiry.
   */
  expireAfterSeconds?: number;
};

export type MongoTtlSpec = {
  /**
   * Document field to use for TTL expiration. Must reference a date-like field in MongoDB.
   */
  field: string;
  /**
   * Retention window in seconds.
   */
  expireAfterSeconds: number;
  /**
   * Optional index name for the TTL index.
   */
  name?: string;
};

export type MongoCollectionMethodContext<TDocument extends Document> = {
  /**
   * The MongoDB client instance
   */
  client: MongoClient;
  /**
   * The MongoDB database instance
   */
  db: Db;
  /**
   * The MongoDB collection instance
   */
  collection: Collection<TDocument>;
  /**
   * The base collection wrapper instance
   */
  base: CollectionWrapper<TDocument>;
};

export type MongoCollectionDefinition<
  TDocument extends Document = Document,
  TMethods extends MongoCollectionMethods = {},
> = {
  name?: string;
  /**
   * Whether to automatically track revisions of documents in this collection. If enabled, every update will insert a copy of the updated document into a separate revision collection, allowing you to keep a history of changes. The revision collection will have the same name as the main collection with `_revisions` appended to it (e.g. `users` -> `users_revisions`).
   */
  trackRevisions: boolean;
  schema: SchemaParser<TDocument>;
  /**
   * Custom methods to add to the collection wrapper. These methods receive a context object with the MongoDB client, database, collection, and base wrapper instance, allowing you to build complex queries and operations while still benefiting from the schema validation and soft delete functionality provided by the base wrapper.
   * @param ctx
   * @returns
   */
  methods?: (ctx: MongoCollectionMethodContext<TDocument>) => TMethods;
  /**
   * Optional array of index specifications to create on this collection. Indexes are created idempotently on service startup, so duplicate indexes are safely ignored.
   */
  indexes?: MongoIndexSpec[];
  /**
   * Optional MongoDB time-series settings. When provided, the collection is created as a time-series collection if it does not already exist.
   */
  timeSeries?: MongoTimeSeriesSpec;
  /**
   * Optional collection-level TTL configuration. This creates a TTL index without requiring `indexes` to be defined.
   */
  ttl?: MongoTtlSpec;
};

export type MongoCollectionsConfig = Record<
  string,
  MongoCollectionDefinition<any, MongoCollectionMethods>
>;

type InferDocument<TDefinition> = TDefinition extends {
  schema: SchemaParser<infer TDocument>;
}
  ? TDocument
  : Document;

type NormalizeDocument<TDocument> = TDocument extends Document
  ? TDocument
  : Document;

type InferMethods<TDefinition> = TDefinition extends {
  methods: (...args: any[]) => infer TMethods;
}
  ? TMethods
  : TDefinition extends {
        methods?: (...args: any[]) => infer TMethods;
      }
    ? TMethods extends undefined
      ? {}
      : TMethods
    : {};

export type MongoBoundCollection<
  TDocument extends Document,
  TMethods extends MongoCollectionMethods = {},
> = CollectionWrapper<TDocument> & TMethods;

export type InferMongoCollections<TCollections extends MongoCollectionsConfig> =
  {
    [K in keyof TCollections]: MongoBoundCollection<
      NormalizeDocument<InferDocument<TCollections[K]>>,
      InferMethods<TCollections[K]>
    >;
  };

export type MongoDatabase<TCollections extends MongoCollectionsConfig> = {
  client: MongoClient;
  db: Db;
  collections: InferMongoCollections<TCollections>;
  disconnect: () => Promise<void>;
  connect: () => Promise<MongoClient>;
} & InferMongoCollections<TCollections>;

type SchemaOutput<TSchema> = TSchema extends {
  parse: (input: unknown) => infer TOutput;
}
  ? NormalizeDocument<TOutput>
  : Document;

/**
 * Define a MongoDB collection with an associated Zod schema for validation and optional custom methods. The returned collection definition can then be used to create a MongoDatabase instance, which will automatically wrap the collection with the provided schema validation and methods.
 * @param config The configuration object for the MongoDB collection, including the schema and optional custom methods.
 */
export function defineMongoCollection<
  TSchema extends SchemaParser<any>,
>(config: {
  /**
   * Optional name for the collection. If not provided, the key used in the collections config will be used as the collection name. This allows you to have more control over the actual collection names in the database, while still using descriptive keys in your code.
   */
  name?: string;
  /**
   * Zod schema for validating documents in the collection. The schema will be used to parse and validate documents returned from the database, ensuring that they conform to the expected structure and types. If a document does not match the schema, an error will be thrown.
   */
  schema: TSchema;
  methods?: undefined;
  /**
   * Optional array of index specifications to create on this collection.
   */
  indexes?: MongoIndexSpec[];
  /**
   * Optional MongoDB time-series settings.
   */
  timeSeries?: MongoTimeSeriesSpec;
  /**
   * Optional collection-level TTL configuration.
   */
  ttl?: MongoTtlSpec;
}): MongoCollectionDefinition<SchemaOutput<TSchema>, {}>;

/**
 * Define a MongoDB collection with an associated Zod schema for validation and optional custom methods. The returned collection definition can then be used to create a MongoDatabase instance, which will automatically wrap the collection with the provided schema validation and methods.
 * @param config The configuration object for the MongoDB collection, including the schema and optional custom methods.
 */
export function defineMongoCollection<
  TSchema extends SchemaParser<any>,
  TMethods extends MongoCollectionMethods,
>(config: {
  /**
   * Optional name for the collection. If not provided, the key used in the collections config will be used as the collection name. This allows you to have more control over the actual collection names in the database, while still using descriptive keys in your code.
   */
  name?: string;
  /**
   * Zod schema for validating documents in the collection. The schema will be used to parse and validate documents returned from the database, ensuring that they conform to the expected structure and types. If a document does not match the schema, an error will be thrown.
   */
  schema: TSchema;
  /**
   * Optional custom methods for the collection. These methods will be added to the collection instance and can be used to implement custom queries or operations.
   * @param ctx The context object containing the MongoDB client, database, collection, and base collection wrapper.
   * @returns An object containing the custom methods to be added to the collection instance.
   */
  methods: (
    ctx: MongoCollectionMethodContext<SchemaOutput<TSchema>>,
  ) => TMethods;
  /**
   * Optional array of index specifications to create on this collection.
   */
  indexes?: MongoIndexSpec[];
  /**
   * Optional MongoDB time-series settings.
   */
  timeSeries?: MongoTimeSeriesSpec;
  /**
   * Optional collection-level TTL configuration.
   */
  ttl?: MongoTtlSpec;
}): MongoCollectionDefinition<SchemaOutput<TSchema>, TMethods>;

/**
 * Define a MongoDB collection with an associated Zod schema for validation and optional custom methods. The returned collection definition can then be used to create a MongoDatabase instance, which will automatically wrap the collection with the provided schema validation and methods.
 * @param config The configuration object for the MongoDB collection, including the schema and optional custom methods.
 */
export function defineMongoCollection<
  TSchema extends SchemaParser<any>,
  TMethods extends MongoCollectionMethods = {},
>(config: {
  /**
   * Optional name for the collection. If not provided, the key used in the collections config will be used as the collection name. This allows you to have more control over the actual collection names in the database, while still using descriptive keys in your code.
   */
  name?: string;
  /**
   * Zod schema for validating documents in the collection. The schema will be used to parse and validate documents returned from the database, ensuring that they conform to the expected structure and types. If a document does not match the schema, an error will be thrown.
   */
  schema: TSchema;
  /**
   * Optional custom methods for the collection. These methods will be added to the collection instance and can be used to implement custom queries or operations.
   * @param ctx The context object containing the MongoDB client, database, collection, and base collection wrapper.
   * @returns An object containing the custom methods to be added to the collection instance.
   */
  methods?: (
    ctx: MongoCollectionMethodContext<SchemaOutput<TSchema>>,
  ) => TMethods;
  /**
   * Optional array of index specifications to create on this collection.
   */
  indexes?: MongoIndexSpec[];
  /**
   * Optional MongoDB time-series settings.
   */
  timeSeries?: MongoTimeSeriesSpec;
  /**
   * Optional collection-level TTL configuration.
   */
  ttl?: MongoTtlSpec;
}): MongoCollectionDefinition<SchemaOutput<TSchema>, TMethods> {
  return {
    name: config.name,
    schema: config.schema,
    /**
     * Optional custom methods for the collection. These methods will be added to the collection instance and can be used to implement custom queries or operations.
     * @param ctx The context object containing the MongoDB client, database, collection, and base collection wrapper.
     * @returns An object containing the custom methods to be added to the collection instance.
     */
    methods: config.methods,
    indexes: config.indexes,
    timeSeries: config.timeSeries,
    ttl: config.ttl,
    /**
     * Whether to automatically track revisions of documents in this collection. If enabled, every update will insert a copy of the updated document into a separate revision collection, allowing you to keep a history of changes. The revision collection will have the same name as the main collection with `_revisions` appended to it (e.g. `users` -> `users_revisions`).
     */
    trackRevisions: false,
  } as MongoCollectionDefinition<SchemaOutput<TSchema>, TMethods>;
}

export function createMongo<TCollections extends MongoCollectionsConfig>(
  dbName: string,
  config: TCollections,
  options: { uri?: string } = {},
): MongoDatabase<TCollections> {
  const client = new MongoClient(
    options.uri || process.env.MONGO_URI || "mongodb://mongo:27017",
  );
  const db = client.db(dbName);

  const wrapped = {} as InferMongoCollections<TCollections>;
  const setupFns: Array<() => Promise<void>> = [];

  for (const key in config) {
    const def = config[key];
    const collectionName = def.name || key;
    const collection = db.collection(collectionName);
    const revisionCollection = def.trackRevisions
      ? db.collection(`${collectionName}_revisions`)
      : undefined;
    const base = new CollectionWrapper(
      collection as Collection<any>,
      def.schema,
      revisionCollection,
    );
    const methods =
      def.methods?.({
        client,
        db,
        collection: collection as Collection<any>,
        base,
      }) || {};

    setupFns.push(async () => {
      if (def.timeSeries) {
        const existingCollection = await db
          .listCollections({ name: collectionName }, { nameOnly: false })
          .next();

        if (!existingCollection) {
          await db.createCollection(collectionName, {
            timeseries: {
              timeField: def.timeSeries.timeField,
              ...(def.timeSeries.metaField
                ? { metaField: def.timeSeries.metaField }
                : {}),
              ...(def.timeSeries.granularity
                ? { granularity: def.timeSeries.granularity }
                : {}),
            },
            ...(typeof def.timeSeries.expireAfterSeconds === "number"
              ? { expireAfterSeconds: def.timeSeries.expireAfterSeconds }
              : {}),
          });
        } else {
          const hasTimeSeriesOptions =
            existingCollection.type === "timeseries" ||
            Boolean((existingCollection.options as any)?.timeseries);

          if (!hasTimeSeriesOptions) {
            throw new Error(
              `Collection ${collectionName} already exists and is not a time-series collection. Migration is required before enabling timeSeries.`,
            );
          }

          const existingTimeSeries = (existingCollection.options as any)
            ?.timeseries as
            | {
                timeField?: string;
                metaField?: string;
              }
            | undefined;

          if (
            existingTimeSeries?.timeField &&
            existingTimeSeries.timeField !== def.timeSeries.timeField
          ) {
            throw new Error(
              `Collection ${collectionName} has timeField '${existingTimeSeries.timeField}' but config expects '${def.timeSeries.timeField}'.`,
            );
          }

          if (
            def.timeSeries.metaField &&
            existingTimeSeries?.metaField &&
            existingTimeSeries.metaField !== def.timeSeries.metaField
          ) {
            throw new Error(
              `Collection ${collectionName} has metaField '${existingTimeSeries.metaField}' but config expects '${def.timeSeries.metaField}'.`,
            );
          }
        }
      }

      if (def.indexes && def.indexes.length > 0) {
        for (const indexSpec of def.indexes) {
          const { key, ...indexOptions } = indexSpec;
          await collection.createIndex(key, indexOptions).catch((err) => {
            console.error(
              `Failed to create index on ${collectionName}: ${err.message}`,
            );
          });
        }
      }

      if (def.ttl) {
        if (!def.ttl.field || def.ttl.field.trim().length === 0) {
          throw new Error(
            `Collection ${collectionName} has invalid ttl.field configuration.`,
          );
        }

        await collection
          .createIndex(
            { [def.ttl.field]: 1 },
            {
              expireAfterSeconds: def.ttl.expireAfterSeconds,
              ...(def.ttl.name ? { name: def.ttl.name } : {}),
            },
          )
          .catch((err) => {
            console.error(
              `Failed to create TTL index on ${collectionName}: ${err.message}`,
            );
          });
      }
    });

    wrapped[key] = Object.assign(
      base,
      methods,
    ) as InferMongoCollections<TCollections>[typeof key];
  }

  let setupPromise: Promise<void> | null = null;

  const ensureSetup = async () => {
    if (!setupPromise) {
      setupPromise = (async () => {
        for (const setup of setupFns) {
          await setup();
        }
      })();
    }
    return setupPromise;
  };

  return {
    client,
    db,
    collections: wrapped,
    ...wrapped,
    disconnect: async () => client.close(),
    connect: async () => {
      await client.connect();
      await ensureSetup();
      return client;
    },
  } as MongoDatabase<TCollections>;
}
