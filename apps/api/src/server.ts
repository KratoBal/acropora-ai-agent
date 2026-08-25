import Fastify from "fastify";

const app = Fastify({
  logger: true
});

app.get("/health", async () => {
  return {
    ok: true,
    service: "acropora-ai-api",
    environment: process.env.NODE_ENV ?? "unknown",
    timestamp: new Date().toISOString()
  };
});

const port = Number(process.env.PORT ?? 3000);

app.listen({
  host: "0.0.0.0",
  port
}).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
