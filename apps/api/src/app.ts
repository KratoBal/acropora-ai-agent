import Fastify from "fastify";
import OpenAI from "openai";
import { pool } from "./db.js";
import {
  conversationBelongsToClient,
  createConversation,
  getConversationMessages,
  saveMessage
} from "./conversations.js";
import {
  customerChatFields,
  customerChatInstructions,
  customerContextErrorBody,
  resolveCustomerContext,
  type CustomerContextSuccess
} from "./customer-context.js";

const ASSISTANT_INSTRUCTIONS =
  "You are the Acropora marine aquarium assistant. Answer in Hungarian, clearly and safely. Use the previous conversation context. Do not invent measurements or diagnoses.";

/**
 * The complete instruction text handed to the model.
 *
 * Assembled by a function rather than inline in the route so that "the model
 * is told which mode it is in" can be asserted. It is the requirement of this
 * change, and a requirement that only exists inside a request handler is a
 * requirement nobody measures.
 */
export function chatInstructions(
  resolution: CustomerContextSuccess
): string {
  return [ASSISTANT_INSTRUCTIONS, customerChatInstructions(resolution)].join(
    "\n\n"
  );
}

/**
 * Builds the HTTP application without starting it.
 *
 * Split out of `server.ts` so that a test can drive the real routes with
 * `app.inject()`. It is not cosmetic: the wiring between a route and the code
 * it calls is exactly the part a hand-built unit test cannot reach, and on the
 * OS side of this same feature that gap hid a defect that would have stopped
 * the whole API from booting.
 *
 * `server.ts` stays the entry point, so the container still runs
 * `node dist/server.js`.
 */
export function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
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

    /**
     * The customer is resolved before anything is written.
     *
     * A chat that cannot say who it is for has no context to give the model, and
     * Balazs's mapping has a 404 for an unknown customer - which only makes
     * sense if the customer is part of the request rather than an extra. Doing
     * it here also keeps the database clean: a request that ends in 404 does not
     * leave a conversation and a stored message behind.
     */
    const resolvedCustomer = await resolveCustomerContext(
      request.headers["x-acropora-user-id"]
    );

    if (!resolvedCustomer.ok) {
      request.log.warn(
        {
          customerContextError: resolvedCustomer.error,
          customerContextDetail: resolvedCustomer.detail
        },
        "customer context lookup failed"
      );

      return reply
        .code(resolvedCustomer.status)
        .send(customerContextErrorBody(resolvedCustomer));
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

    const history = await getConversationMessages(
      activeConversationId,
      20
    );

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    try {
      const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        instructions: [
          "You are the Acropora marine aquarium assistant. Answer in Hungarian, clearly and safely. Use the previous conversation context. Do not invent measurements or diagnoses.",
          customerChatInstructions(resolvedCustomer)
        ].join("\n\n"),
        input: history.map((item) => ({
          role: item.role,
          content: item.content
        })),
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
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        // Temporary, so that the binding is visible from the outside. See
        // customerChatFields, which also decides what an anonymous chat gets.
        ...customerChatFields(resolvedCustomer)
      };
    } catch (error) {
      request.log.error({ error }, "OpenAI request failed");

      return reply.code(502).send({
        error: "ai_provider_error"
      });
    }
  });

  return app;
}
