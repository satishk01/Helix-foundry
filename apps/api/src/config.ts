import "dotenv/config";
import { resolve } from "node:path";
import { checkTimeLimits } from "../../../services/executor/src/limits.js";
export const config = {
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
  // There is no sign-in, so listening beyond this computer must be explicit
  // (e.g. inside a container whose port is published only on loopback).
  allowNetwork: process.env.ALLOW_NETWORK_ACCESS === "true",
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
  helix: process.env.HELIX_URL || "http://127.0.0.1:6969",
  // Native development without Docker: run HelixDB embedded in-process
  // (native library, data under HELIX_DIR) instead of a server at helix.
  helixEmbedded: process.env.HELIX_EMBEDDED === "true",
  helixDir: resolve(
    process.env.HELIX_DIR || `${process.env.DATA_DIR || ".data"}/helix`,
  ),
  executor: process.env.EXECUTOR_URL || "http://127.0.0.1:3002",
  internalKey: process.env.INTERNAL_KEY || "",
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  dataDir: resolve(process.env.DATA_DIR || ".data"),
  inlineWorker: process.env.INLINE_WORKER !== "false",
  // Multi-person deployment: require sign-in instead of the single-computer
  // local identity. Sessions are created through /api/v1/auth/login.
  requireLogin: process.env.REQUIRE_LOGIN === "true",
  ollama: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  // Ollama keep_alive: free the model's memory soon after a question instead
  // of after Ollama's default five minutes.
  modelKeepAlive: process.env.MODEL_KEEP_ALIVE || "30s",
  // Requests per minute per IP; local acceptance runs raise it.
  rateLimit: Number(process.env.RATE_LIMIT_MAX) || 240,
  // Remote store for immutable dataset snapshots: s3://bucket[/prefix], or an
  // Azure Blob container URL with a SAS token. Empty keeps snapshots local.
  snapshotUri: process.env.SNAPSHOT_URI || "",
  // S3 keys; empty uses the AWS credential chain (instance role, environment).
  snapshotAccessKeyId: process.env.SNAPSHOT_ACCESS_KEY_ID || "",
  snapshotSecretAccessKey: process.env.SNAPSHOT_SECRET_ACCESS_KEY || "",
  // Endpoint for S3-compatible stores such as MinIO. Empty uses AWS.
  snapshotEndpoint: process.env.SNAPSHOT_ENDPOINT || "",
  // Local cache cap for hydrated snapshots, such as 20GB. Empty keeps them.
  snapshotCacheLimit: process.env.SNAPSHOT_CACHE_LIMIT || "",
};
export function requireSecrets() {
  if (config.encryptionKey.length < 32 || config.internalKey.length < 32)
    throw new Error(
      "Run ./scripts/setup.sh to generate ENCRYPTION_KEY and INTERNAL_KEY (32+ characters).",
    );
}
// Checked when the app and the worker start, so a mistake in .env stops them
// with a message that names the setting, instead of /api/health passing while
// every query fails.
export function requireSettings() {
  requireSecrets();
  checkTimeLimits();
}
