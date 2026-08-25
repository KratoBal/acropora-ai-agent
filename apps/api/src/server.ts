import Fastify from "fastify";
import OpenAI from "openai";

const app = Fastify({
  logger: true,
  trustProxy: true
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const rateLimitPerMinute = 20;
const rateWindowMs = 60_000;

const rateBuckets = new Map<
  string,
  { startedAt: number; count: number }
>();

function consumeRateLimit(key: string): boolean {
  const now = Date.now();
  const current = rateBuckets.get(key);

  if (!current || now - current.startedAt >= rateWindowMs) {
    rateBuckets.set(key, {
      startedAt: now,
      count: 1
    });

    return true;
  }

  if (current.count >= rateLimitPerMinute) {
    return false;
  }

  current.count += 1;
  return true;
}

app.get("/health", async () => {
  return {
    ok: true,
    service: "acropora-ai-api",
    environment: process.env.NODE_ENV ?? "unknown",
    timestamp: new Date().toISOString()
  };
});

app.post<{
  Body: {
    message?: string;
  };
}>("/v1/chat", async (request, reply) => {
  const expectedToken = process.env.API_ACCESS_TOKEN;
  const providedToken = request.headers.authorization;

  if (
    !expectedToken ||
    providedToken !== `Bearer ${expectedToken}`
  ) {
    return reply.code(401).send({
      error: "unauthorized"
    });
  }

  const rateLimitKey = request.ip;

  if (!consumeRateLimit(rateLimitKey)) {
    return reply
      .code(429)
      .header("Retry-After", "60")
      .send({
        error: "rate limit exceeded"
      });
  }

  const message = request.body?.message?.trim();

  if (!message) {
    return reply.code(400).send({
      error: "message is required"
    });
  }

  if (message.length > 4000) {
    return reply.code(413).send({
      error: "message is too long"
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return reply.code(503).send({
      error: "AI provider is not configured"
    });
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.1",
    instructions:
      "You are the Acropora marine aquarium assistant. Answer in Hungarian, clearly and safely. Do not invent measurements or diagnoses.",
    input: message,
    store: false
  });

  return {
    answer: response.output_text,
    model: process.env.OPENAI_MODEL ?? "gpt-5.1"
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
