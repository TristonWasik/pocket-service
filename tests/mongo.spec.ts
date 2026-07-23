/// <reference types="vitest/globals" />
import z from "zod";
import {
  defineMongoCollection,
  MongoCollectionDefinition,
} from "../src/workers/db/mongo/mongo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Service } from "../src/workers/service";

describe("MongoDB Dependency", () => {
  let service: Service<{
    testCollection: MongoCollectionDefinition<
      {
        name: string;
      },
      {}
    >;
  }>;
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    service = new Service()
      .withName("admin-service")
      .withPort(4120)
      .withRedis("redis://localhost:6379")
      .withMongo({
        dbName: "test",
        uri,
        collections: {
          testCollection: defineMongoCollection({
            schema: z.object({
              name: z.string(),
            }),
          }),
        },
      })
      .build();
  });

  afterEach(async () => {
    await service.db.testCollection.delete({});
  });

  afterAll(async () => {
    await mongoServer.stop();
  });

  it("Should contain the custom collection", () => {
    expect(service.db).toHaveProperty("testCollection");
  });

  it("Should not contain undefined collection", () => {
    expect(() => service.db).not.toHaveProperty("undefinedCollection");
  });

  it("Should be initialized", () => {
    expect(() => service.mongo).not.toThrow();
  });

  it("Should return an empty array when getting from an empty collection", async () => {
    const res = await service.db.testCollection.get();
    expect(res).toEqual([]);
  });

  it("Should insert and retrieve documents correctly", async () => {
    await service.db.testCollection.insert({ name: "test" });
    const res = await service.db.testCollection.get({});
    expect(res.length).toBe(1);
    expect(res[0].name).toEqual("test");
  });

  it("Should delete documents correctly", async () => {
    await service.db.testCollection.insert({ name: "toDelete" });
    await service.db.testCollection.delete({ name: "toDelete" });
    const res = await service.db.testCollection.get({ name: "toDelete" });
    expect(res).toEqual([]);
  });

  it("Should update documents correctly", async () => {
    await service.db.testCollection.insert({ name: "toUpdate" });
    await service.db.testCollection.updateOne(
      { name: "toUpdate" },
      { name: "updated" },
    );
    const res = await service.db.testCollection.get({ name: "updated" });
    expect(res.length).toBe(1);
    expect(res[0].name).toEqual("updated");
    console.log("Updated document:", res[0]);
  });

  it("Should support creating and using time-series collections", async () => {
    const tsService = new Service()
      .withName("admin-service")
      .withPort(4121)
      .withRedis("redis://localhost:6379")
      .withMongo({
        dbName: "test_timeseries",
        uri: mongoServer.getUri(),
        collections: {
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
            },
          }),
        },
      })
      .build();

    await tsService.mongo.connect();

    const collectionInfo = await tsService.mongo.db
      .listCollections({ name: "metrics" }, { nameOnly: false })
      .next();

    expect(
      collectionInfo?.type === "timeseries" ||
        Boolean((collectionInfo?.options as any)?.timeseries),
    ).toBe(true);

    await tsService.db.metrics.insert({
      timestamp: new Date(),
      host: "app-1",
      value: 42,
    });
    const values = await tsService.db.metrics.get({ host: "app-1" });

    expect(values.length).toBe(1);
    expect(values[0].value).toBe(42);

    await tsService.mongo.disconnect();
  });
});
