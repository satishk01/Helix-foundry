import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../apps/api/src/config.js";
import {
  checkSnapshotConfig,
  ensureSnapshot,
  removeSnapshot,
  sweepSnapshotCache,
  uploadSnapshot,
} from "../apps/api/src/snapshots.js";

// The S3 branch is tested at the command level: the mock client records the
// commands it is sent, and the fake GetObject answers from a virtual bucket.
const s3 = vi.hoisted(() => ({
  sent: [] as any[],
  objects: new Map<string, Buffer>(),
}));
vi.mock("@aws-sdk/client-s3", async () => {
  const { Readable } = await import("node:stream");
  return {
    S3Client: class {
      constructor(public opts: any) {}
      async send(command: any) {
        s3.sent.push(command);
        if (command.put) {
          const chunks: Buffer[] = [];
          for await (const c of command.put.Body) chunks.push(c);
          s3.objects.set(command.put.Key, Buffer.concat(chunks));
          return {};
        }
        if (command.get) {
          const body = s3.objects.get(command.get.Key);
          if (!body) {
            const e: any = new Error("The specified key does not exist.");
            e.name = "NoSuchKey";
            throw e;
          }
          return { Body: Readable.from([body]) };
        }
        if (command.del) {
          s3.objects.delete(command.del.Key);
          return {};
        }
        throw new Error("unexpected command");
      }
    },
    PutObjectCommand: class {
      constructor(public put: any) {}
    },
    GetObjectCommand: class {
      constructor(public get: any) {}
    },
    DeleteObjectCommand: class {
      constructor(public del: any) {}
    },
  };
});

const scopes: string[] = [];
function scope() {
  const s = "snap-" + randomUUID();
  scopes.push(s);
  return s;
}
const parquet = (scope: string, version: string) =>
  resolve(config.dataDir, "datasets", scope, version + ".parquet");
const env = { uri: "", endpoint: "", keyId: "", secret: "", limit: "" };
afterEach(async () => {
  vi.unstubAllGlobals();
  config.snapshotUri = env.uri;
  config.snapshotEndpoint = env.endpoint;
  config.snapshotAccessKeyId = env.keyId;
  config.snapshotSecretAccessKey = env.secret;
  config.snapshotCacheLimit = env.limit;
  s3.sent.length = 0;
  s3.objects.clear();
  for (const s of scopes.splice(0))
    await rm(resolve(config.dataDir, "datasets", s), {
      recursive: true,
      force: true,
    });
});
beforeEach(() => {
  env.uri = config.snapshotUri;
  env.endpoint = config.snapshotEndpoint;
  env.keyId = config.snapshotAccessKeyId;
  env.secret = config.snapshotSecretAccessKey;
  env.limit = config.snapshotCacheLimit;
});

it("rejects a bad SNAPSHOT_URI at startup", () => {
  config.snapshotUri = "ftp://not-a-store";
  expect(() => checkSnapshotConfig()).toThrow("SNAPSHOT_URI must be");
  config.snapshotUri = "";
  expect(() => checkSnapshotConfig()).not.toThrow();
  config.snapshotUri = "s3://bucket/prefix";
  config.snapshotCacheLimit = "a lot";
  expect(() => checkSnapshotConfig()).toThrow("SNAPSHOT_CACHE_LIMIT");
});

it("uploads and hydrates snapshots through S3", async () => {
  config.snapshotUri = "s3://bucket/foundry";
  config.snapshotAccessKeyId = "test-key";
  config.snapshotSecretAccessKey = "test-secret";
  const s = scope(),
    version = randomUUID();
  await mkdir(resolve(config.dataDir, "datasets", s), { recursive: true });
  await writeFile(parquet(s, version), "PARQUET-A");
  await uploadSnapshot(s, version);
  expect(s3.objects.get(`foundry/${s}/${version}.parquet`)?.toString()).toBe(
    "PARQUET-A",
  );
  // Hydrate a copy the cache lost.
  await rm(parquet(s, version));
  await ensureSnapshot(s, version);
  expect(await readFile(parquet(s, version), "utf8")).toBe("PARQUET-A");
  // A present file is not downloaded again.
  const calls = s3.sent.length;
  await ensureSnapshot(s, version);
  expect(s3.sent.length).toBe(calls);
  // A missing remote snapshot says what happened.
  await expect(ensureSnapshot(s, randomUUID())).rejects.toThrow(
    "missing locally and from the remote store",
  );
  await removeSnapshot(s, version);
  expect(s3.objects.size).toBe(0);
});

it("uploads and hydrates snapshots through an Azure Blob SAS URL", async () => {
  config.snapshotUri =
    "https://acct.blob.core.windows.net/box/foundry?sv=token";
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any = {}) => {
      requests.push({ url, method: init.method || "GET", headers: init.headers || {} });
      if (init.method === "PUT") return new Response("", { status: 201 });
      if (init.method === "DELETE") return new Response("", { status: 202 });
      return new Response("PARQUET-B", { status: 200 });
    }),
  );
  const s = scope(),
    version = randomUUID();
  await mkdir(resolve(config.dataDir, "datasets", s), { recursive: true });
  await writeFile(parquet(s, version), "PARQUET-B");
  await uploadSnapshot(s, version);
  const put = requests.find((r) => r.method === "PUT");
  expect(put.url).toBe(
    `https://acct.blob.core.windows.net/box/foundry/${s}/${version}.parquet?sv=token`,
  );
  expect(put.headers["x-ms-blob-type"]).toBe("BlockBlob");
  expect(put.headers["content-length"]).toBe("9");
  await rm(parquet(s, version));
  await ensureSnapshot(s, version);
  expect(await readFile(parquet(s, version), "utf8")).toBe("PARQUET-B");
});

it("keeps snapshots local with no remote configured", async () => {
  config.snapshotUri = "";
  const s = scope(),
    version = randomUUID();
  // No remote: a missing local file is left for the executor to fail on,
  // exactly as before.
  await ensureSnapshot(s, version);
  await uploadSnapshot(s, version);
  await removeSnapshot(s, version);
});

it("evicts the least recently read snapshots over the cache limit", async () => {
  config.snapshotUri = "s3://bucket";
  config.snapshotCacheLimit = "6";
  const s = scope(),
    oldV = randomUUID(),
    newV = randomUUID();
  await mkdir(resolve(config.dataDir, "datasets", s), { recursive: true });
  await writeFile(parquet(s, oldV), "AAAAA");
  await writeFile(parquet(s, newV), "BBBBB");
  const old = new Date(Date.now() - 3600_000),
    fresh = new Date(Date.now() - 11 * 60000);
  await utimes(parquet(s, oldV), old, old);
  await utimes(parquet(s, newV), fresh, fresh);
  await sweepSnapshotCache();
  await expect(readFile(parquet(s, oldV))).rejects.toThrow();
  expect(await readFile(parquet(s, newV), "utf8")).toBe("BBBBB");
});
