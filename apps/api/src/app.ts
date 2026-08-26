import Fastify from "fastify";
import type OpenAI from "openai";
import { pool } from "./db.js";
import {
  conversationBelongsToClient,
  createConversation,
  getConversationMessages,
  saveMessage
} from "./conversations.js";
import {
  aiProviderFailure,
  aiProviderLimits,
  createAiClient
} from "./ai-provider.js";
import { safeErrorSummary } from "./redact.js";
import { buildVersion } from "./build-version.js";
import {
  answerIsRatable,
  conversationRatings,
  isRatingValue,
  rateAnswer,
  RATING_VALUES,
  type StoredRating
} from "./evaluations.js";
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
 * What the model is told about our own catalogue: that it has none.
 *
 * This is mode-independent, and that is the point. An anonymous visitor and a
 * resolved customer are both asking someone who cannot see a single product,
 * price or stock level - the catalogue is simply not wired into this service.
 *
 * It is stated for the same reason the missing customer context is stated: an
 * absence that says nothing gets filled in. A model that is not told it lacks
 * product data will answer a product question from general knowledge, and a
 * confident guess about a price or a stock level speaks in place of the shop.
 * That is not a test-surface concern; it is the same on any surface.
 *
 * When the catalogue does arrive, this block is what changes - and the
 * difference in the answers is the evidence that wiring it in was worth doing.
 */
export const NO_PRODUCT_CONTEXT_INSTRUCTIONS = [
  "You have no data about Acropora's own products, prices, stock or offers.",
  "The catalogue is not available to you in this conversation, and you must",
  "not fill that gap from general knowledge or from a product name that sounds",
  "familiar.",
  "",
  "The line is not about how a question is phrased. It is about what you can",
  "SEE. What you know about the world you may say - about a brand, about a type",
  "of product, about what a thing is for. What you cannot see is what Acropora",
  "carries, what is in stock and what it costs, and about that you say nothing",
  "at all: not yes, not no, not 'typically available from us'. A question that",
  "takes it for granted that we stock something ('do we have any X?') is still",
  "a question about what you cannot see, and answering it with yes or no is the",
  "mistake.",
  "",
  "Correcting a false premise is different, and it is welcome. If someone asks",
  "about a product that does not exist, say that it does not exist and why -",
  "that is knowledge about the world, and it is worth more than declining to",
  "answer. Just leave our range out of it: correct the premise, and do not add",
  "whether we carry it.",
  "",
  "And whether or not our name comes up: do not recommend a specific product to",
  "buy. In a conversation carried by Acropora, 'get this one' reads as 'we sell",
  "this one' even when nobody said so. Describing a brand or a product in",
  "general terms is welcome; steering someone to a particular item is not."
].join("\n");

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
  return [
    ASSISTANT_INSTRUCTIONS,
    NO_PRODUCT_CONTEXT_INSTRUCTIONS,
    customerChatInstructions(resolution)
  ].join("\n\n");
}

/**
 * The conversation storage the chat route uses.
 *
 * Named as a type so a test can hand the route a stand-in and drive the whole
 * handler, model call included. Before this existed, every route test had to
 * stop at the first database call, which left the last third of the handler -
 * the part that decides what the model is told - with no test going through it
 * at all. That is not a hypothetical gap: the clause about our own catalogue
 * was written, exported and asserted, and the route never called it.
 */
export interface ConversationStore {
  createConversation(clientKey: string): Promise<string>;
  conversationBelongsToClient(
    conversationId: string,
    clientKey: string
  ): Promise<boolean>;
  saveMessage(input: {
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    model?: string;
  }): Promise<string>;
  getConversationMessages(
    conversationId: string,
    limit?: number
  ): Promise<
    Array<{
      role: "user" | "assistant" | "system";
      content: string;
    }>
  >;
}

const databaseConversationStore: ConversationStore = {
  createConversation,
  conversationBelongsToClient,
  saveMessage,
  getConversationMessages
};

/**
 * Where a judgement about an answer is written and read back.
 *
 * Separate from the conversation store rather than folded into it, because
 * they answer to different things: one is the transcript, the other is what
 * somebody thought of it. A rating can be replaced and a message cannot.
 */
export interface RatingStore {
  answerIsRatable(messageId: string, clientKey: string): Promise<boolean>;
  rateAnswer(input: {
    messageId: string;
    rating: (typeof RATING_VALUES)[number];
    ratedBy: string;
  }): Promise<StoredRating>;
  conversationRatings(
    conversationId: string,
    clientKey: string
  ): Promise<StoredRating[]>;
}

const databaseRatingStore: RatingStore = {
  answerIsRatable,
  rateAnswer,
  conversationRatings
};

/**
 * What may be substituted when the app is built.
 *
 * All three default to the real thing, so production wiring is unchanged and
 * there is no test-only branch inside a handler.
 */
/**
 * Just enough of a logger for Fastify, and for a test to read back.
 *
 * Typed here rather than imported from pino because what matters is the shape
 * the route calls, not the implementation behind it.
 */
export interface AppLogger {
  info(payload: unknown, message?: string): void;
  error(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
  debug(payload: unknown, message?: string): void;
  fatal(payload: unknown, message?: string): void;
  trace(payload: unknown, message?: string): void;
  child(bindings: unknown): AppLogger;
  level: string;
  silent(payload: unknown, message?: string): void;
}

export interface AppDependencies {
  openai?: OpenAI;
  conversations?: ConversationStore;
  ratings?: RatingStore;
  /**
   * Substituted so a test can read back what a log line was GIVEN.
   *
   * The upstream failure branch redacts the provider's error before logging
   * it, and that redaction was the one claim in this service nothing held in
   * place: `safeErrorSummary` is covered from every angle, but the line that
   * calls it was not, so putting the raw error object back would have left
   * every test green. Reaching the branch is not enough - the assertion needs
   * the payload.
   */
  logger?: AppLogger;
  /**
   * The liveness check the health route runs against the database.
   *
   * Substitutable for the same reason the rest of this object is: without it
   * no test can reach the health response at all, because the real query
   * needs a database. A version field nobody can assert is a field nobody
   * should trust.
   */
  databaseCheck?: () => Promise<void>;
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
export function buildApp(dependencies: AppDependencies = {}) {
  const limits = aiProviderLimits();
  const conversations =
    dependencies.conversations ?? databaseConversationStore;
  const ratings = dependencies.ratings ?? databaseRatingStore;
  const databaseCheck =
    dependencies.databaseCheck ??
    (async () => {
      await pool.query("SELECT 1");
    });

  const app = Fastify({
    ...(dependencies.logger
      ? { loggerInstance: dependencies.logger }
      : { logger: process.env.NODE_ENV !== "test" }),
    trustProxy: true,
    /**
     * The net under the ladder, not a step on it.
     *
     * It closes the connection without an HTTP answer, so it must never be
     * what fires in normal operation - the model call gives up five seconds
     * earlier and says so. This is here for a handler stuck somewhere the
     * model timeout cannot reach, the database being the obvious one.
     */
    connectionTimeout: limits.connectionTimeoutMs
  });

  /**
   * Both limits are passed explicitly, even though one of them happens to
   * match a default we could have inherited. An inherited default is not a
   * decision: it can change with the next version of the SDK, and nobody would
   * notice until a request started taking three times as long.
   */
  const openai = dependencies.openai ?? createAiClient(limits);

  const rateLimitPerMinute = 20;
  /**
   * Higher than the chat ceiling, and on its own budget.
   *
   * Rating is a click, not a model call: someone working through a list of
   * test questions rates far more often than they ask, and changing a mind
   * costs another write. Sharing the chat bucket would mean the judgements
   * eat the allowance for the questions.
   */
  const ratingLimitPerMinute = 60;
  const rateWindowMs = 60_000;

  const rateBuckets = new Map<
    string,
    { startedAt: number; count: number }
  >();

  function consumeRateLimit(
    key: string,
    limit = rateLimitPerMinute
  ): boolean {
    const now = Date.now();
    const current = rateBuckets.get(key);

    if (!current || now - current.startedAt >= rateWindowMs) {
      rateBuckets.set(key, {
        startedAt: now,
        count: 1
      });

      return true;
    }

    if (current.count >= limit) {
      return false;
    }

    current.count += 1;
    return true;
  }

  /**
   * The shared token, checked in one place.
   *
   * It was inline in the chat handler while there was one handler. A second
   * route copying the comparison is how two gates end up subtly different -
   * and the weaker of the two is the one that decides.
   */
  function tokenIsValid(authorization: string | undefined): boolean {
    const expected = process.env.API_ACCESS_TOKEN;

    return Boolean(expected) && authorization === `Bearer ${expected}`;
  }

  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  /**
   * Which caller a conversation and its ratings belong to.
   *
   * Read the same way by both routes on purpose: ownership is only a boundary
   * if the two sides of it agree on what the key is. A rating route that
   * defaulted differently would accept writes against conversations the chat
   * route would refuse to continue.
   */
  function clientKeyOf(header: unknown): string {
    return typeof header === "string" && header.length > 0
      ? header.slice(0, 128)
      : "stage-test-client";
  }

  app.get("/health", async () => {
    await databaseCheck();

    return {
      ok: true,
      service: "acropora-ai-api",
      environment: process.env.NODE_ENV ?? "unknown",
      /**
       * Which code this actually is.
       *
       * Added because a measurement could not be closed without it. On
       * 2026-08-26 a clause was wired into the route, deployed, and measured
       * on stage - and the strongest statement anyone could make about WHICH
       * code answered those calls was "the deploy workflow ran for that sha
       * and went green". That is evidence about a workflow, not about the
       * process serving the request.
       *
       * `unknown` is a real answer and not a failure: a container started by
       * hand has no sha to report, and pretending otherwise would be worse
       * than saying so.
       */
      version: buildVersion(),
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
    if (!tokenIsValid(request.headers.authorization)) {
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

    const clientKey = clientKeyOf(request.headers["x-client-key"]);

    let conversationId = request.body?.conversationId;

    if (conversationId) {
      if (!UUID_PATTERN.test(conversationId)) {
        return reply.code(400).send({
          error: "invalid conversationId"
        });
      }

      const belongsToClient = await conversations.conversationBelongsToClient(
        conversationId,
        clientKey
      );

      if (!belongsToClient) {
        return reply.code(404).send({
          error: "conversation not found"
        });
      }
    } else {
      conversationId = await conversations.createConversation(clientKey);
    }

    const activeConversationId = conversationId;

    await conversations.saveMessage({
      conversationId: activeConversationId,
      role: "user",
      content: message
    });

    const history = await conversations.getConversationMessages(
      activeConversationId,
      20
    );

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        instructions: chatInstructions(resolvedCustomer),
        input: history.map((item) => ({
          role: item.role,
          content: item.content
        })),
        store: false
      });

      const answerMessageId = await conversations.saveMessage({
        conversationId: activeConversationId,
        role: "assistant",
        content: response.output_text,
        model: process.env.OPENAI_MODEL ?? "gpt-5.1"
      });

      return {
        conversationId: activeConversationId,
        /**
         * The handle a judgement is written against.
         *
         * Without it the surface would have to guess which answer it is
         * rating, and "the last one" stops being true as soon as a second
         * question is sent before the first is judged.
         */
        messageId: answerMessageId,
        answer: response.output_text,
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        // Temporary, so that the binding is visible from the outside. See
        // customerChatFields, which also decides what an anonymous chat gets.
        ...customerChatFields(resolvedCustomer)
      };
    } catch (error) {
      const failure = aiProviderFailure(error, Date.now() - askedAt);

      // The error object is never handed to the logger: its shape belongs to
      // the provider, and a provider error can quote a key back at us.
      request.log.error(
        {
          aiProviderError: safeErrorSummary(error),
          aiProviderOutcome: failure.body.error,
          waitedMs: failure.body.waitedMs,
          timeoutMs: limits.timeoutMs
        },
        "OpenAI request failed"
      );

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * What somebody thought of one answer.
   *
   * The judgement lives here rather than in the browser because that is the
   * entire point of collecting it: a rating kept in page state is gone on
   * reload, and a measurement that disappears when a tab closes is not a
   * measurement. The internal test surface is how the answers get judged, and
   * this is where the judgement lands.
   *
   * It is a separate call rather than a field on the chat request, because
   * the judgement happens after the answer has been read - sometimes minutes
   * after, sometimes changed once the next answer puts it in context.
   */
  app.post<{
    Params: { messageId: string };
    Body: {
      rating?: unknown;
      ratedBy?: unknown;
    };
  }>("/v1/messages/:messageId/rating", async (request, reply) => {
    if (!tokenIsValid(request.headers.authorization)) {
      return reply.code(401).send({
        error: "unauthorized"
      });
    }

    if (!consumeRateLimit(`rating:${request.ip}`, ratingLimitPerMinute)) {
      return reply
        .code(429)
        .header("Retry-After", "60")
        .send({
          error: "rate limit exceeded"
        });
    }

    const { messageId } = request.params;

    if (!UUID_PATTERN.test(messageId)) {
      return reply.code(400).send({
        error: "invalid messageId"
      });
    }

    const rating = request.body?.rating;

    if (!isRatingValue(rating)) {
      /**
       * The accepted values travel with the refusal.
       *
       * A bare "invalid rating" would leave the caller guessing at a list that
       * lives in two repositories, and the surface in front is written by
       * somebody who cannot read this file.
       */
      return reply.code(400).send({
        error: "invalid rating",
        allowed: RATING_VALUES
      });
    }

    const ratedByRaw = request.body?.ratedBy;
    const ratedBy =
      typeof ratedByRaw === "string" ? ratedByRaw.trim().slice(0, 128) : "";

    if (!ratedBy) {
      /**
       * Required, and not defaulted to something anonymous.
       *
       * Who judged an answer is half of what makes the judgement readable
       * later: two people disagreeing about the same answer is a finding, and
       * it is invisible if both rows say "someone". It is also what lets a
       * person change their own mind without overwriting anybody else's.
       */
      return reply.code(400).send({
        error: "ratedBy is required"
      });
    }

    const clientKey = clientKeyOf(request.headers["x-client-key"]);

    if (!(await ratings.answerIsRatable(messageId, clientKey))) {
      /**
       * One 404 for three different situations - no such message, someone
       * else's conversation, or a question rather than an answer - and that is
       * deliberate: distinguishing them would tell the caller which message
       * ids exist.
       */
      return reply.code(404).send({
        error: "answer not found"
      });
    }

    const stored = await ratings.rateAnswer({
      messageId,
      rating,
      ratedBy
    });

    return reply.code(200).send(stored);
  });

  /**
   * The judgements already given in one conversation.
   *
   * Read back by the surface so a rating survives a reload, which is what
   * storing it was for.
   */
  app.get<{
    Params: { conversationId: string };
  }>("/v1/conversations/:conversationId/ratings", async (request, reply) => {
    if (!tokenIsValid(request.headers.authorization)) {
      return reply.code(401).send({
        error: "unauthorized"
      });
    }

    const { conversationId } = request.params;

    if (!UUID_PATTERN.test(conversationId)) {
      return reply.code(400).send({
        error: "invalid conversationId"
      });
    }

    const clientKey = clientKeyOf(request.headers["x-client-key"]);

    return {
      conversationId,
      ratings: await ratings.conversationRatings(conversationId, clientKey)
    };
  });

  return app;
}
