import {
  Collection,
  Document,
  Filter,
  ObjectId,
  OptionalUnlessRequiredId,
  UpdateFilter,
  WithId,
} from "mongodb";

export type SchemaParser<T extends Document> = {
  parse: (input: unknown) => T;
  shape?: unknown;
  _def?: {
    shape?: unknown | (() => unknown);
  };
};

export class CollectionWrapper<T extends Document> {
  constructor(
    private readonly collection: Collection<T>,
    private readonly schema?: SchemaParser<T>,
    private readonly revision?: Collection<T>,
  ) {}

  private parseWrite(doc: unknown): T {
    if (!this.schema) {
      return doc as T;
    }
    return this.schema.parse(doc);
  }

  private parseRead(doc: WithId<T>): WithId<T> {
    if (!this.schema) {
      return doc;
    }

    const parsed = this.schema.parse(doc) as T;

    return {
      ...(parsed as Document),
      _id: doc._id,
    } as WithId<T>;
  }

  private async trackRevision(doc: T) {
    if (this.revision) {
      const clone = {
        ...doc,
        _id: new ObjectId(),
      } as OptionalUnlessRequiredId<T>;
      await this.revision.insertOne(clone);
    }
  }

  /**
   * Get all documents from the collection.
   * @param filter - The filter to find documents to retrieve. If no filter is provided, it will return all documents in the collection.
   * @returns
   */
  async get(filter: Filter<T> = {}): Promise<WithId<T>[]> {
    try {
      if (this.hasProperty("deletedAt")) {
        // If the schema has a `deletedAt` field, filter out soft-deleted documents
        filter = { ...filter, deletedAt: { $exists: false } };
      }
      const result = await this.collection.find(filter).toArray();
      return result.map((doc) => this.parseRead(doc));
    } catch (err) {
      return [];
    }
  }

  /**
   * Get a single document from the collection.
   * @param filter - The filter to find the document to retrieve. If no filter is provided, it will return the first document in the collection.
   * @returns
   */
  async getOne(filter: Filter<T> = {}): Promise<WithId<T> | null> {
    try {
      if (this.hasProperty("deletedAt")) {
        // If the schema has a `deletedAt` field, filter out soft-deleted documents
        filter = { ...filter, deletedAt: { $exists: false } };
      }
      const result = await this.collection.findOne(filter);
      return result ? this.parseRead(result) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Get all revisions for a document.
   * @param filter - The filter to find revisions to retrieve. If no filter is provided, it will return all revisions in the revision collection.
   * @returns An array of revision documents.
   */
  async getRevisions(filter: Filter<T> = {}): Promise<WithId<T>[]> {
    try {
      if (!this.revision) {
        return [];
      }
      const result = await this.revision
        .find(filter, { sort: { revision: 1 } })
        .toArray();
      return result.map((doc) => this.parseRead(doc as WithId<T>));
    } catch (err) {
      return [];
    }
  }

  /**
   * Get the most recent revision for a document.
   * @returns Revision document or null if no revisions exist or if revision tracking is not enabled.
   */
  async getMostRecentRevision(): Promise<WithId<T> | null> {
    try {
      if (!this.revision) {
        return null;
      }
      const result = await this.revision
        .find({}, { sort: { revision: -1 } })
        .limit(1)
        .toArray();
      return result.length > 0 ? this.parseRead(result[0] as WithId<T>) : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Insert a document into the collection.
   *
   * If this collection has revision tracking enabled, it will also insert the document into the revision collection.
   *
   * @param doc - The document to insert into the collection.
   */
  async insert(doc: T): Promise<void> {
    try {
      const parsed = this.parseWrite(doc);
      await this.collection.insertOne(parsed as OptionalUnlessRequiredId<T>);
      await this.trackRevision(parsed);
    } catch (err) {
      throw new Error(`Failed to insert document: ${(err as Error).message}`);
    }
  }

  /**
   * Update multiple documents by filter with a partial document.
   * @param filter - The filter to find documents to update.
   * @param update - The partial document to update.
   */
  async update(filter: Filter<T>, update: Partial<T>): Promise<void> {
    try {
      const existing = await this.collection.find(filter).toArray();
      if (!existing.length) return;

      await this.collection.updateMany(filter, { $set: update });

      // record updated versions in revisions
      if (this.revision) {
        const updatedDocs = existing.map((doc) => ({
          ...doc,
          ...update,
          _id: new ObjectId(),
        }));
        await this.revision.insertMany(
          updatedDocs as OptionalUnlessRequiredId<T>[],
        );
      }
    } catch (err) {
      throw new Error(`Failed to update documents: ${(err as Error).message}`);
    }
  }

  /**
   * Update a single document by filter with a partial document. This will automatically set the `updatedAt` field to the current date if it exists in the schema, and increment the `revision` field by 1 if it exists in the schema. It will also insert the updated document into the revision collection if revision tracking is enabled.
   * @param filter - The filter to find the document to update.
   * @param update - The partial document to update.
   */
  async updateOne(filter: Filter<T>, update: Partial<T>): Promise<void> {
    try {
      const incomingUpdate = this.hasProperty("updatedAt")
        ? { ...update, updatedAt: new Date() }
        : update;
      const updateDoc = {
        $set: incomingUpdate,
        ...(this.revision ? { $inc: { revision: 1 } } : {}),
      } as UpdateFilter<T>;

      await this.collection.updateOne(filter, updateDoc);
      if (this.revision) {
        await this.collection
          .aggregate([
            {
              $match: filter,
            },
            {
              $set: { ...update, _id: new ObjectId() },
            },
            {
              $merge: {
                into: this.revision.collectionName,
                on: "_id",
                whenNotMatched: "insert",
              },
            },
          ])
          .toArray();
      }
    } catch (err) {
      console.error("Failed to update document:", err);
      throw new Error(`Failed to update document: ${(err as Error).message}`);
    }
  }

  /**
   * Soft delete a document by setting the `deletedAt` field to the current date.
   * If the schema has a `deletedBy` field, it is set to the provided actor or defaults to `system`.
   * If the schema does not have a `deletedAt` field, it will perform a hard delete.
   * @param filter - The filter to find documents to delete.
   * @param deletedBy - Optional actor identifier for soft deletes.
   */
  async delete(filter: Filter<T>, deletedBy?: string): Promise<void> {
    try {
      if (this.hasProperty("deletedAt")) {
        const deletedAt = new Date();
        const deletedByValue = deletedBy ?? "system";
        const setFields: Record<string, unknown> = {
          deletedAt,
          ...(this.hasProperty("deletedBy")
            ? { deletedBy: deletedByValue }
            : {}),
        };
        const update = {
          $set: setFields,
        } as unknown as UpdateFilter<T>;
        await this.collection.updateMany(filter, update);
        if (this.revision) {
          await this.collection
            .aggregate([
              {
                $match: filter,
              },
              {
                $set: { _id: new ObjectId(), ...setFields },
              },
              {
                $merge: {
                  into: this.revision.collectionName,
                  on: "_id",
                  whenNotMatched: "insert",
                },
              },
            ])
            .toArray();
        }
      } else {
        await this.collection.deleteMany(filter);
      }
    } catch (err) {
      throw new Error(`Failed to delete documents: ${(err as Error).message}`);
    }
  }

  /**
   * Checks if the schema has a given property.
   * @param schema - The Zod schema to check against.
   * @param property - The property to check for in the schema.
   * @returns
   */
  private hasProperty(property: string): boolean {
    if (!this.schema) {
      return false;
    }

    const schemaLike = this.schema as SchemaParser<T>;
    const shapeSource =
      schemaLike.shape ??
      (typeof schemaLike._def?.shape === "function"
        ? schemaLike._def.shape()
        : schemaLike._def?.shape);

    if (
      shapeSource !== null &&
      typeof shapeSource === "object" &&
      !Array.isArray(shapeSource)
    ) {
      return property in shapeSource;
    }

    return false;
  }
}
