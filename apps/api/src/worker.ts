import { requireSettings } from "./config.js";
import { checkSnapshotConfig } from "./snapshots.js";
import { store } from "./store.js";
import { startWorker } from "./jobs.js";
requireSettings();
checkSnapshotConfig();
await store.init();
const stop = startWorker(store);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await stop();
    process.exit(0);
  });
