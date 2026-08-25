import { buildApp } from "./app.js";
import { initializeDatabase } from "./db.js";

const app = buildApp();

async function start(): Promise<void> {
  await initializeDatabase();

  await app.listen({
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 3000)
  });
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
