/// <reference types="vitest/globals" />
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import z from "zod";
import {
  createMongo,
  defineMongoCollection,
  type MongoCollectionsConfig,
} from "../../src/modules/mongo/mongo";

describe("Mongo abstraction advanced behaviors", () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
  });

  afterAll(async () => {
    await mongoServer.stop();
  });

  it("supports soft delete filtering and deletedBy attribution", async () => {
    const mongo = createMongo(
      "soft_delete_db",
      {
        users: defineMongoCollection({
          schema: z.object({
            name: z.string(),
            deletedAt: z.date().optional(),
            deletedBy: z.string().optional(),
          }),
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await mongo.connect();

    await mongo.users.insert({ name: "Ada" });
    await mongo.users.delete({ name: "Ada" });

    await mongo.users.insert({ name: "Grace" });
    await mongo.users.delete({ name: "Grace" }, "admin-user");

    const visible = await mongo.users.get({ name: "Ada" });
    const rawAda = await mongo.db.collection("users").findOne({ name: "Ada" });
    const rawGrace = await mongo.db.collection("users").findOne({
      name: "Grace",
    });

    expect(visible).toEqual([]);
    expect(rawAda?.deletedAt).toBeInstanceOf(Date);
    expect(rawAda?.deletedBy).toBe("system");
    expect(rawGrace?.deletedBy).toBe("admin-user");

    await mongo.disconnect();
  });

  it("tracks revisions and updates updatedAt/revision on updateOne", async () => {
    const config = {
      records: {
        ...defineMongoCollection({
          schema: z.object({
            key: z.string(),
            value: z.string(),
            revision: z.number().default(0),
            updatedAt: z.date().optional(),
          }),
        }),
        trackRevisions: true,
      },
    } satisfies MongoCollectionsConfig;

    const mongo = createMongo("revisions_db", config, {
      uri: mongoServer.getUri(),
    });

    await mongo.connect();

    await mongo.records.insert({
      key: "k1",
      value: "v1",
      revision: 0,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    await mongo.records.updateOne({ key: "k1" }, { value: "v2" });

    const current = await mongo.records.getOne({ key: "k1" });
    const revisions = await mongo.records.getRevisions({ key: "k1" });
    const mostRecent = await mongo.records.getMostRecentRevision();

    expect(current?.value).toBe("v2");
    expect(current?.revision).toBe(1);
    expect(current?.updatedAt).toBeInstanceOf(Date);
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(mostRecent?.value).toBe("v2");

    await mongo.disconnect();
  });

  it("creates configured indexes during setup", async () => {
    const mongo = createMongo(
      "index_setup_db",
      {
        users: defineMongoCollection({
          schema: z.object({
            email: z.string(),
            createdAt: z.date(),
          }),
          indexes: [
            { key: { email: 1 }, unique: true, name: "users_email_unique" },
            { key: { createdAt: 1 }, name: "users_created_at" },
          ],
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await mongo.connect();

    const indexes = await mongo.db.collection("users").indexes();

    expect(indexes.some((idx) => idx.name === "users_email_unique")).toBe(true);
    expect(indexes.some((idx) => idx.name === "users_created_at")).toBe(true);

    await mongo.disconnect();
  });

  it("creates TTL index from collection ttl config without using indexes", async () => {
    const dbName = `collection_ttl_${new ObjectId().toHexString()}`;

    const mongo = createMongo(
      dbName,
      {
        sessions: defineMongoCollection({
          schema: z.object({
            userId: z.string(),
            expiresAt: z.date(),
          }),
          ttl: {
            field: "expiresAt",
            expireAfterSeconds: 120,
            name: "sessions_ttl_expires_at",
          },
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await mongo.connect();

    const indexes = await mongo.db.collection("sessions").indexes();
    const ttlIndex = indexes.find(
      (idx) => idx.name === "sessions_ttl_expires_at",
    );

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex?.key).toMatchObject({ expiresAt: 1 });
    expect(ttlIndex?.expireAfterSeconds).toBe(120);

    await mongo.disconnect();
  });

  it("fails when enabling timeSeries on an existing non-time-series collection", async () => {
    const dbName = `timeseries_mismatch_${new ObjectId().toHexString()}`;

    const initial = createMongo(
      dbName,
      {
        metrics: defineMongoCollection({
          schema: z.object({
            timestamp: z.date(),
            value: z.number(),
          }),
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await initial.connect();
    await initial.db.createCollection("legacy_metrics");
    await initial.disconnect();

    const withTimeSeries = createMongo(
      dbName,
      {
        legacy_metrics: defineMongoCollection({
          schema: z.object({
            timestamp: z.date(),
            value: z.number(),
          }),
          timeSeries: {
            timeField: "timestamp",
          },
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await expect(withTimeSeries.connect()).rejects.toThrow(
      "already exists and is not a time-series collection",
    );

    await withTimeSeries.disconnect();
  });

  it("creates time-series collections with configured options and reconnects safely", async () => {
    const dbName = `timeseries_options_${new ObjectId().toHexString()}`;

    const mongo = createMongo(
      dbName,
      {
        metrics: defineMongoCollection({
          schema: z.object({
            timestamp: z.date(),
            host: z.string(),
            value: z.number(),
          }),
          timeSeries: {
            timeField: "timestamp",
            metaField: "host",
            granularity: "seconds",
            expireAfterSeconds: 3600,
          },
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await mongo.connect();

    const collectionInfo = await mongo.db
      .listCollections({ name: "metrics" }, { nameOnly: false })
      .next();

    const timeSeriesOptions = (collectionInfo?.options as any)?.timeseries;

    expect(
      collectionInfo?.type === "timeseries" || Boolean(timeSeriesOptions),
    ).toBe(true);
    expect(timeSeriesOptions?.timeField).toBe("timestamp");
    expect(timeSeriesOptions?.metaField).toBe("host");
    expect(timeSeriesOptions?.granularity).toBe("seconds");
    expect((collectionInfo?.options as any)?.expireAfterSeconds).toBe(3600);

    await mongo.disconnect();

    const reconnect = createMongo(
      dbName,
      {
        metrics: defineMongoCollection({
          schema: z.object({
            timestamp: z.date(),
            host: z.string(),
            value: z.number(),
          }),
          timeSeries: {
            timeField: "timestamp",
            metaField: "host",
            granularity: "seconds",
            expireAfterSeconds: 3600,
          },
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await expect(reconnect.connect()).resolves.toBeDefined();
    await reconnect.disconnect();
  });

  it("fails when existing time-series metaField does not match config", async () => {
    const dbName = `timeseries_metafield_mismatch_${new ObjectId().toHexString()}`;

    const initial = createMongo(
      dbName,
      {
        metrics: defineMongoCollection({
          schema: z.object({
            timestamp: z.date(),
            hostA: z.string(),
            value: z.number(),
          }),
          timeSeries: {
            timeField: "timestamp",
            metaField: "hostA",
          },
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await initial.connect();
    await initial.disconnect();

    const mismatched = createMongo(
      dbName,
      {
        metrics: defineMongoCollection({
          schema: z.object({
            timestamp: z.date(),
            hostB: z.string(),
            value: z.number(),
          }),
          timeSeries: {
            timeField: "timestamp",
            metaField: "hostB",
          },
        }),
      },
      { uri: mongoServer.getUri() },
    );

    await expect(mismatched.connect()).rejects.toThrow(
      "has metaField 'hostA' but config expects 'hostB'",
    );

    await mismatched.disconnect();
  });
});
