import "dotenv/config";
import { buildServer } from "./api/server.js";
import { ensureIndexes } from "./core/db.js";
import { startCrons } from "./cron.js";
import { recoverInterruptedRuns } from "./agent/runner.js";

const port = Number(process.env.PORT ?? 4400);

const app = await buildServer();
await ensureIndexes();
await recoverInterruptedRuns();
startCrons({ scheduledWork: process.env.ENABLE_CRONS !== "false" });

await app.listen({ port, host: "0.0.0.0" });
console.log(`search-optimizer listening on :${port}`);
