import Fastify from "fastify";
import OpenAI from "openai";
import { initializeDatabase, pool } from "./db.js";
import {
  conversationBelongsToClient,
  createConversation,
  saveMessage
} from "./conversations.js";

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
  await pool.query("SELECT 1");

  return {
    ok: true,
    service: "acropora-ai-api",
    environment: process.env.NODE_ENV ?? "unknown",
    database: "ok",
    timestamp: new Date().toISOString()
  };
});

app.post<{
  Body: {
    message?: string;
    conversationId?: string;
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

  if (!consumeRateLimit(request.ip)) {
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

  const clientKeyHeader = request.headers["x-client-key"];
  const clientKey =
    typeof clientKeyHeader === "string" &&
    clientKeyHeader.length > 0
      ? clientKeyHeader.slice(0, 128)
      : "stage-test-client";

  let conversationId = request.body?.conversationId;

  if (conversationId) {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(conversationId)) {
      return reply.code(400).send({
        error: "invalid conversationId"
      });
    }

    const belongsToClient = await conversationBelongsToClient(
      conversationId,
      clientKey
    );

    if (!belongsToClient) {
      return reply.code(404).send({
        error: "conversation not found"
      });
    }
  } else {
    conversationId = await createConversation(clientKey);
  }

  const activeConversationId = conversationId;

  await saveMessage({
    conversationId: activeConversationId,
    role: "user",
    content: message
  });

  if (!process.env.OPENAI_API_KEY) {
    return reply.code(503).send({
      error: "AI provider is not configured"
    });
  }

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.1",
      instructions:
        "You are the Acropora marine aquarium assistant. Answer in Hungarian, clearly and safely. Do not invent measurements or diagnoses.",
      input: message,
      store: false
    });

    await saveMessage({
      conversationId: activeConversationId,
      role: "assistant",
      content: response.output_text,
      model: process.env.OPENAI_MODEL ?? "gpt-5.1"
    });

    return {
      conversationId: activeConversationId,
      answer: response.output_text,
      model: process.env.OPENAI_MODEL ?? "gpt-5.1"
    };
  } catch (error) {
    request.log.error({ error }, "OpenAI request failed");

    return reply.code(502).send({
      error: "ai_provider_error"
    });
  }
});

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
