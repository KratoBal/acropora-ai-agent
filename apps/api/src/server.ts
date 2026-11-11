import { buildApp } from "./app.js";
import { initializeDatabase, pool } from "./db.js";
import { startRetention } from "./retention.js";

const app = buildApp();

async function start(): Promise<void> {
  await initializeDatabase();

  // The daily retention job: off unless AI_CHAT_RETENTION is exactly `true` (see retention.ts).
  startRetention(pool, app.log);

  await app.listen({
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 3000)
  });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
