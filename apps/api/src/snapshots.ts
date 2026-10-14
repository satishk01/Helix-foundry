// Remote storage for immutable dataset snapshots (DATA_DIR/datasets/<scope>/
// <version>.parquet). SNAPSHOT_URI picks a store: s3://bucket[/prefix] for S3,
// or an Azure Blob container URL with a SAS token. Unset keeps snapshots
// local, which is also how a hydrated file behaves afterwards: the remote
// store holds the durable copy and DATA_DIR is a cache the sweeper bounds.
//
// The executor never talks to object storage: it stays on its internal
// network and reads and writes plain files. The API uploads files the
// executor has finished writing, and downloads inputs before a job starts.
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { bytes } from "../../../services/executor/src/engine.js";
import { config } from "./config.js";
import { AppError } from "./security.js";

const localPath = (scope: string, version: string) =>
  resolve(config.dataDir, "datasets", scope, version + ".parquet");

type Remote = {
  upload(scope: string, version: string, path: string): Promise<void>;
  // Returns false when the object does not exist.
  download(scope: string, version: string, path: string): Promise<boolean>;
  remove(scope: string, version: string): Promise<void>;
};

function s3Remote(uri: string): Remote {
  const [, bucket, raw = ""] =
    /^s3:\/\/([^/?\s]+)(?:\/(\S*))?$/.exec(uri) || [];
  if (!bucket) throw new Error(uriError);
  const prefix = raw && !raw.endsWith("/") ? raw + "/" : raw;
  const client = new S3Client({
    region:
      process.env.SNAPSHOT_REGION || process.env.AWS_REGION || "us-east-1",
    endpoint: config.snapshotEndpoint || undefined,
    forcePathStyle: !!config.snapshotEndpoint,
    // Without keys the default chain applies: environment, then the
    // EC2/ECS instance role.
    credentials: config.snapshotAccessKeyId
      ? {
          accessKeyId: config.snapshotAccessKeyId,
          secretAccessKey: config.snapshotSecretAccessKey,
        }
      : undefined,
  });
  const key = (scope: string, version: string) =>
    `${prefix}${scope}/${version}.parquet`;
  return {
    async upload(scope, version, path) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(scope, version),
          Body: createReadStream(path),
        }),
      );
    },
    async download(scope, version, path) {
      try {
        const r = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key(scope, version) }),
        );
        if (!r.Body) return false;
        await pipeline(r.Body as Readable, createWriteStream(path));
        return true;
      } catch (e: any) {
        if (
          ["NoSuchKey", "NotFound", "NoSuchBucket"].includes(e?.name) ||
          e?.$metadata?.httpStatusCode === 404
        )
          return false;
        throw e;
      }
    },
    async remove(scope, version) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key(scope, version) }),
      );
    },
  };
}

function azureRemote(url: URL): Remote {
  // <account>.blob.core.windows.net/<container>/<prefix>?<sas>
  const parts = url.pathname.split("/").filter(Boolean);
  const container = parts.shift();
  if (!container)
    throw new Error(
      "SNAPSHOT_URI must name an Azure Blob container, such as https://<account>.blob.core.windows.net/<container>/<prefix>?<sas>",
    );
  const base = `${url.origin}/${container}/${parts.join("/")}${
    parts.length ? "/" : ""
  }`;
  const sas = url.search;
  const blob = (scope: string, version: string) =>
    `${base}${scope}/${version}.parquet${sas}`;
  const check = (r: Response, verb: string) => {
    if (!r.ok)
      throw new AppError(
        502,
        `Snapshot store ${verb} failed with HTTP ${r.status}. Check SNAPSHOT_URI and its SAS token.`,
      );
  };
  return {
    async upload(scope, version, path) {
      const size = (await stat(path)).size;
      const r = await fetch(blob(scope, version), {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "content-length": String(size),
        },
        body: Readable.toWeb(createReadStream(path)) as any,
        duplex: "half",
      } as any);
      check(r, "upload");
    },
    async download(scope, version, path) {
      const r = await fetch(blob(scope, version));
      if (r.status === 404) return false;
      check(r, "download");
      if (!r.body) return false;
      await pipeline(
        Readable.fromWeb(r.body as any),
        createWriteStream(path),
      );
      return true;
    },
    async remove(scope, version) {
      const r = await fetch(blob(scope, version), { method: "DELETE" });
      if (r.status !== 404) check(r, "delete");
    },
  };
}

const uriError =
  "SNAPSHOT_URI must be s3://bucket[/prefix] or https://<account>.blob.core.windows.net/<container>/<prefix>?<sas>";
let cached: { uri: string; remote: Remote } | null = null;
function remoteStore(): Remote | null {
  const uri = config.snapshotUri.trim();
  if (!uri) return null;
  if (cached?.uri !== uri) {
    let remote: Remote;
    if (uri.startsWith("s3://")) remote = s3Remote(uri);
    else {
      const u = new URL(uri);
      if (
        u.protocol === "https:" &&
        u.hostname.endsWith(".blob.core.windows.net")
      )
        remote = azureRemote(u);
      else throw new Error(uriError);
    }
    cached = { uri, remote };
  }
  return cached.remote;
}

// Fails fast at startup, with the setting named, instead of failing the first
// import or question that needs the store.
export function checkSnapshotConfig() {
  const limit = config.snapshotCacheLimit.trim();
  if (limit && !(bytes(limit) > 0))
    throw new Error(`Invalid SNAPSHOT_CACHE_LIMIT: ${limit} (sizes like 20GB)`);
  remoteStore();
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

// Brings the version's snapshot into the local cache when it is missing.
// With no remote store this is a no-op and a missing file fails downstream,
// as it always has.
export async function ensureSnapshot(scope: string, version: string) {
  const file = localPath(scope, version);
  if (await exists(file)) return;
  const store = remoteStore();
  if (!store) return;
  await mkdir(dirname(file), { recursive: true });
  // A second download of the same version writes another partial file; the
  // rename of a complete file is all readers rely on.
  const tmp = file + ".partial-" + randomUUID();
  try {
    if (await store.download(scope, version, tmp)) await rename(tmp, file);
    else
      throw new AppError(
        422,
        "A dataset snapshot is missing locally and from the remote store. Re-import the dataset.",
      );
  } finally {
    await rm(tmp, { force: true });
  }
}

// Uploads the snapshot the executor just wrote. Fails the calling job when
// the durable copy cannot be stored, rather than report success for data the
// remote store does not hold.
export async function uploadSnapshot(scope: string, version: string) {
  const store = remoteStore();
  if (!store) return;
  await store.upload(scope, version, localPath(scope, version)).catch((e) => {
    throw new AppError(
      502,
      `The snapshot could not be stored in the remote store: ${
        e instanceof Error ? e.message : e
      }`,
    );
  });
}

// A dropped snapshot's remote copy is best effort: the version id is never
// reused, so a leftover object only wastes storage.
export async function removeSnapshot(scope: string, version: string) {
  await remoteStore()
    ?.remove(scope, version)
    .catch((e) =>
      console.error(
        `Snapshot ${version} could not be removed from the remote store:`,
        e instanceof Error ? e.message : e,
      ),
    );
}

// Keeps the local cache under SNAPSHOT_CACHE_LIMIT by removing the snapshots
// least recently read, which hydration replaces on demand. Files written in
// the last ten minutes are left alone: an executor may still be using them.
export async function sweepSnapshotCache() {
  const limit = config.snapshotCacheLimit.trim();
  if (!remoteStore() || !limit) return;
  const max = bytes(limit),
    root = resolve(config.dataDir, "datasets"),
    files: { path: string; atime: number; size: number }[] = [];
  for (const scope of await readdir(root).catch(() => [] as string[]))
    for (const name of await readdir(resolve(root, scope)).catch(
      () => [] as string[],
    )) {
      if (!name.endsWith(".parquet")) continue;
      const path = resolve(root, scope, name),
        info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 10 * 60000)
        files.push({ path, atime: info.atimeMs, size: info.size });
    }
  let total = files.reduce((n, f) => n + f.size, 0);
  files.sort((a, b) => a.atime - b.atime);
  for (const f of files) {
    if (total <= max) break;
    if (
      await rm(f.path, { force: true }).then(
        () => true,
        () => false,
      )
    )
      total -= f.size;
  }
}
