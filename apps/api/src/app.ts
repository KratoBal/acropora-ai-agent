import Fastify from "fastify";
import type OpenAI from "openai";
import { pool } from "./db.js";
import {
  conversationBelongsToClient,
  createConversation,
  getConversationMessages,
  maskUserMessage,
  saveMessage,
  setMessageOutcome,
  type MessageUsage
} from "./conversations.js";
import { findContact } from "./contact-mask.js";
import { contactRequestConfig, handOverContact } from "./contact-request.js";
import {
  CONTACT_FORWARDED_ANSWER,
  CONTACT_NOT_FORWARDED_ANSWER,
  CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS,
  CONTACT_ASK_KIND,
  CONTACT_OFFER_KIND,
  CONTACT_REQUEST_MODEL_LABEL,
  contactFlowActive,
  maskHandedOver,
  opensContactReply,
  withContactOffer
} from "./contact-request-flow.js";
import {
  aiProviderFailure,
  aiProviderLimits,
  createAiClient
} from "./ai-provider.js";
import { GLOSSARY_INSTRUCTIONS } from "./glossary.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  productContextInstructions,
  productContextSummary
} from "./product-context.js";
import {
  DOSING_EXTRACTION_INSTRUCTIONS,
  dosingExtractionInput,
  guardDosingAnswer,
  parseDosingRequest
} from "./dosing-extraction.js";
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  CLAIMS_AS_JSON,
  claimExtractionInput,
  claimExtractionInstructions,
  guardClaims,
  parseClaimRequest
} from "./claim-extraction.js";
import {
  FIGURE_BODY_LIMIT,
  FIGURE_CLAIM_EXTRACTION_PROMPT_VERSION,
  figureClaimInput,
  figureClaimInstructions,
  guardFigureClaims,
  parseFigureRequest
} from "./figure-claim-extraction.js";
import {
  KNOWLEDGE_ANSWER_PROMPT_VERSION,
  guardKnowledgeAnswer,
  knowledgeAnswerInput,
  knowledgeAnswerInstructions,
  parseKnowledgeAnswerRequest
} from "./knowledge-answer.js";
import {
  RESEARCH_QUERIES_PROMPT_VERSION,
  RESEARCH_SUMMARY_PROMPT_VERSION,
  guardResearchQueries,
  guardResearchSummary,
  parseResearchQuestion,
  parseSummaryRequest,
  researchQueriesInstructions,
  researchSummaryInput,
  researchSummaryInstructions
} from "./research-draft.js";
import { CONTACT_PLACEHOLDER, maskContacts, maskContactsEnabled } from "./contact-mask.js";
import { searchProducts } from "./product-search.js";
import { classifyRequest, type RecentTurn } from "./request-prefilter.js";
import {
  PREFILTER_MODEL_LABEL,
  localAnswerFor,
  prefilterEnabled
} from "./request-prefilter-answers.js";
import {
  COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS,
  customerTurnCount,
  OFFTOPIC_SERIES_FIRM_AT,
  offTopicSeries,
  shouldOfferColleague,
  withColleagueOffer
} from "./request-prefilter-turns.js";
import { safeErrorSummary } from "./redact.js";
import { DOSE_GUARD_FALLBACK, guardAnswerDoses } from "./answer-dose-guard.js";
import {
  LINK_GUARD_FALLBACK,
  LINK_RULE_INSTRUCTIONS,
  guardAnswerLinks,
  linkRuleMode,
  type LinkRuleMode
} from "./answer-link-guard.js";
import { readLinkSources, type LinkSourcesRead } from "./link-sources.js";
import { colleagueOfferActive } from "./colleague-offer-setting.js";
import { readOffTopicThreshold } from "./offtopic-threshold.js";
import {
  guardRecommendationText,
  MEASUREMENT_RECOMMENDATION_INSTRUCTIONS,
  measurementRecommendationInput,
  parseRecommendationRequest
} from "./measurement-recommendation.js";
import { buildTime, buildVersion } from "./build-version.js";
import {
  answerIsRatable,
  conversationRatings,
  isRatingAxis,
  isRatingForAxis,
  rateAnswer,
  RATING_AXES,
  RATINGS_BY_AXIS,
  type RatingAxis,
  type StoredRating
} from "./evaluations.js";
import {
  customerChatFields,
  customerChatInstructions,
  conversationSubject,
  customerContextErrorBody,
  resolveCustomerContext,
  type CustomerContextResult,
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
export { NO_PRODUCT_CONTEXT_INSTRUCTIONS };

export function chatInstructions(
  resolution: CustomerContextSuccess,
  productContext: string,
  options: {
    colleagueOfferActive?: boolean;
    /** The contact request is on (slice 4c): the model is told to ask for the contact instead of saying a colleague cannot be reached. */
    contactRequestActive?: boolean;
    linkRule?: LinkRuleMode;
  } = {}
): string {
  return [
    ASSISTANT_INSTRUCTIONS,
    // FELTETEL NELKUL, es a helye sem veletlen: a szojegyzek nyelvi szabaly,
    // tehat a szemely-blokk mellett all, NEM a termekkontextus agai kozott. Ott
    // egy uzemzavar csendben elvinne a szohasznalatot is.
    GLOSSARY_INSTRUCTIONS,
    // R1 of the link rule (card 9d060f5c): told under `log` and `enforce`, absent
    // under `off`, so the default keeps the prompt what it was.
    ...((options.linkRule ?? "off") === "off" ? [] : [LINK_RULE_INSTRUCTIONS]),
    productContext,
    customerChatInstructions(resolution),
    // Only while the colleague offer is made (see request-prefilter-turns.ts); with the switch off the instructions are unchanged.
    ...(options.colleagueOfferActive
      ? [
          options.contactRequestActive
            ? CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS
            : COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS
        ]
      : [])
  ].join("\n\n");
}

/**
 * The token counts out of a provider answer, if it carried any.
 *
 * WRITTEN DEFENSIVELY ON PURPOSE, and this is the part worth reading. The
 * usage block is the provider's, not ours: it can be absent, it can arrive
 * with a different set of fields after an SDK upgrade, and it can hold
 * something that is not a number. None of that is a reason to fail a chat
 * answer the caller is already waiting for - the answer is the product, the
 * accounting is a note in the margin.
 *
 * So every field is read one by one and only kept if it really is a finite
 * number. Anything else becomes `undefined`, which the column stores as NULL:
 * "we do not know", which is true, rather than zero, which would claim the
 * call was free.
 *
 * `undefined` for the whole object when nothing usable came back, so the
 * caller writes three NULLs and moves on.
 */
export function readUsage(response: unknown): MessageUsage | undefined {
  const usage = (response as { usage?: unknown })?.usage;

  if (!usage || typeof usage !== "object") return undefined;

  const source = usage as Record<string, unknown>;

  const count = (key: string): number | undefined => {
    const value = source[key];

    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };

  const parsed: MessageUsage = {
    inputTokens: count("input_tokens"),
    outputTokens: count("output_tokens"),
    totalTokens: count("total_tokens")
  };

  return parsed.inputTokens === undefined &&
    parsed.outputTokens === undefined &&
    parsed.totalTokens === undefined
    ? undefined
    : parsed;
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
  createConversation(clientKey: string, subject: string): Promise<string>;
  conversationBelongsToClient(
    conversationId: string,
    clientKey: string,
    subject: string
  ): Promise<boolean>;
  saveMessage(input: {
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    model?: string;
    usage?: MessageUsage;
    localKind?: "contact_offer" | "contact_ask";
  }): Promise<string>;
  setMessageOutcome(messageId: string, outcome: string): Promise<void>;
  /** The stored customer message with its contact replaced, after the OS recorded the request (slice 4c). */
  maskUserMessage(messageId: string, maskedContent: string): Promise<void>;
  getConversationMessages(
    conversationId: string,
    limit?: number
  ): Promise<
    Array<{
      role: "user" | "assistant" | "system";
      content: string;
      localKind?: string | null;
    }>
  >;
}

const databaseConversationStore: ConversationStore = {
  createConversation,
  conversationBelongsToClient,
  saveMessage,
  setMessageOutcome,
  maskUserMessage,
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
    axis: RatingAxis;
    rating: string;
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
  /**
   * The customer lookup against the Acropora OS.
   *
   * Substitutable so a test can drive a CUSTOMER chat through the route: with
   * the real lookup and no OS configured, every request with a customer
   * header stops at 502, and the conversation-ownership check behind it
   * could not be reached by any test.
   */
  resolveCustomer?: (rawCustomerId: unknown) => Promise<CustomerContextResult>;
}

/** The longest client key kept (the caller's key is stored with every conversation). */
export const CLIENT_KEY_MAX_LENGTH = 128;
/** A 400's body for an `x-client-key` that is there but is not a key. */
export const INVALID_CLIENT_KEY = "invalid x-client-key";

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
  const resolveCustomer =
    dependencies.resolveCustomer ??
    ((rawCustomerId: unknown) => resolveCustomerContext(rawCustomerId));
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
  function clientKeyOf(header: unknown): string | null {
    // the shared fallback ONLY when the header is missing (card 7a5ea203): a header that is there but is not one key (empty or
    // blank, not a single string, longer than the limit) is refused, never quietly turned into the shared key or cut to a prefix
    // that could equal another caller's
    if (header === undefined) return "stage-test-client";
    return typeof header === "string" &&
      header.trim().length > 0 &&
      header.length <= CLIENT_KEY_MAX_LENGTH
      ? header
      : null;
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
      /**
       * The commit says WHICH code; this says WHICH IMAGE of it.
       *
       * They are not the same question, and one morning proved it: the same
       * commit built twice gave two images, one with a patched `libssl3` and
       * one that kept a cached layer. `version` was identical in both.
       */
      builtAt: buildTime(),
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
    const resolvedCustomer = await resolveCustomer(
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
    if (clientKey === null) return reply.code(400).send({ error: INVALID_CLIENT_KEY });
    /*
     * Who this conversation is about. A conversation is continued only for the
     * same subject it was started for (card a3e0327f): otherwise a second
     * customer's chat - or an anonymous one - would get the first customer's
     * history, both in what the model is handed and in what comes back.
     */
    const subject = conversationSubject(resolvedCustomer);

    let conversationId = request.body?.conversationId;

    if (conversationId) {
      if (!UUID_PATTERN.test(conversationId)) {
        return reply.code(400).send({
          error: "invalid conversationId"
        });
      }

      const belongsToClient = await conversations.conversationBelongsToClient(
        conversationId,
        clientKey,
        subject
      );

      if (!belongsToClient) {
        return reply.code(404).send({
          error: "conversation not found"
        });
      }
    } else {
      conversationId = await conversations.createConversation(
        clientKey,
        subject
      );
    }

    const activeConversationId = conversationId;

    const questionMessageId = await conversations.saveMessage({
      conversationId: activeConversationId,
      role: "user",
      content: message
    });

    /**
     * Writes the outcome down, and never lets that write cost the answer.
     *
     * Same rule as the token counts: the answer is the product, the note in
     * the margin is a note. A failed UPDATE here would turn a served answer
     * into a 500 for the person waiting.
     */
    const noteOutcome = async (outcome: string): Promise<void> => {
      try {
        await conversations.setMessageOutcome(questionMessageId, outcome);
      } catch (error) {
        request.log.error(
          { outcome, reason: safeErrorSummary(error) },
          "could not record the question outcome"
        );
      }
    };

    const history = await conversations.getConversationMessages(
      activeConversationId,
      20
    );

    /**
     * THE CONTACT REQUEST (card f5b8f7ba, slice 4c), BEFORE THE PRE-FILTER: the customer's reply to the colleague offer that carries a
     * contact is handed to the OS and answered HERE, with no model call and no catalogue call. THE ORDER (plan 2 point 2): the OS
     * records it (a receipt with `recorded: true`), THEN the stored message is masked, THEN the local answer says "forwarded"; on
     * any failure the local answer claims no delivery and the raw value stays in the stored row (the retention covers it). Only the
     * channel and the outcome are logged, never the value. `contactFlow` is read once and used for both halves of the flow.
     */
    // the offer's state for this request: the environment's gate and the OS box (card f5b8f7ba, acrobot 49021), read once
    const offerActive = await colleagueOfferActive();
    const contactFlow = await contactFlowActive(process.env, undefined, Date.now(), offerActive);
    const previousRow = history.length >= 2 ? history[history.length - 2] : undefined;
    const foundContact =
      contactFlow &&
      previousRow?.role === "assistant" &&
      opensContactReply(previousRow.localKind)
        ? findContact(message)
        : null;
    const handOverConfig = foundContact ? contactRequestConfig() : null;

    if (foundContact && handOverConfig) {
      const receipt = await handOverContact(
        {
          channel: foundContact.channel,
          value: foundContact.value,
          conversationRef: activeConversationId,
          requestKey: questionMessageId
        },
        { config: handOverConfig }
      );
      request.log.info(
        {
          contactRequest: {
            channel: foundContact.channel,
            ok: receipt.ok,
            ...(receipt.ok
              ? { duplicate: receipt.duplicate, notified: receipt.notified }
              : { error: receipt.error, detail: receipt.detail })
          }
        },
        receipt.ok
          ? "the contact request was handed over to the OS"
          : "the contact request could not be handed over; the stored message is unchanged"
      );
      if (receipt.ok) {
        try {
          await conversations.maskUserMessage(
            questionMessageId,
            maskHandedOver(message, foundContact.value, CONTACT_PLACEHOLDER)
          );
        } catch (error) {
          // The request is recorded; the raw value stays in this service's row until the retention removes it. ONLY the error's name and
          // database code are logged, not `safeErrorSummary`: that keeps the message, and a database message can quote the row.
          request.log.error(
            {
              reason: {
                name: (error as Error)?.name ?? "unknown",
                code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined
              }
            },
            "could not mask the stored message after the hand-over"
          );
        }
      }
      const contactAnswer = receipt.ok
        ? CONTACT_FORWARDED_ANSWER
        : CONTACT_NOT_FORWARDED_ANSWER;
      const contactMessageId = await conversations.saveMessage({
        conversationId: activeConversationId,
        role: "assistant",
        content: contactAnswer,
        model: CONTACT_REQUEST_MODEL_LABEL,
        // a failed hand-over may be retried: the customer's next message with the contact is read as the reply again
        ...(receipt.ok ? {} : { localKind: CONTACT_ASK_KIND })
      });
      await noteOutcome(receipt.ok ? "contact_forwarded" : "contact_not_forwarded");

      return {
        conversationId: activeConversationId,
        messageId: contactMessageId,
        answer: contactAnswer,
        doseGuard: null,
        linkGuard: null,
        model: CONTACT_REQUEST_MODEL_LABEL,
        productContext: {
          state: "not_asked",
          hitCount: null,
          projectionVersion: null,
          descriptionSources: []
        },
        ...customerChatFields(resolvedCustomer)
      };
    }

    /**
     * THE LOCAL PRE-FILTER (card f5b8f7ba), AFTER THE MESSAGE IS SAVED AND BEFORE ANYTHING COSTS: the key check, the catalogue
     * search and the model call all come later. Off by default (`AI_CHAT_PREFILTER`, exactly `true`): off, this block is
     * skipped and the route is what it was.
     *
     * A `block` or an `ask` is answered HERE: no model call, no catalogue call, and the local answer is saved as an assistant
     * message like any other (the next turn's history must hold the question it asked, or the user's reply would arrive to a
     * conversation that never asked). The gate reads the conversation so far WITHOUT the message it is judging (the last
     * stored row is that message). The log line carries the category, the decision and the reason: never a fragment of the text.
     */
    if (prefilterEnabled()) {
      const earlier: RecentTurn[] = history
        .slice(0, -1)
        .filter(
          (item): item is { role: "user" | "assistant"; content: string } =>
            item.role === "user" || item.role === "assistant"
        );
      const verdict = classifyRequest(message, earlier);

      if (verdict.decision !== "pass") {
        // The series is a number, never text. It is replayed from the history (no stored counter).
        const series =
          verdict.decision === "block" ? offTopicSeries(earlier) : 0;
        // the threshold is the OS setting (Balázs 2026-11-11: settable, 5); read only for an off-topic turn, 5 when it cannot be read
        const threshold =
          verdict.decision === "block"
            ? await readOffTopicThreshold().catch(() => null)
            : null;
        const firmAt = threshold?.firmAt ?? OFFTOPIC_SERIES_FIRM_AT;
        request.log.info(
          {
            prefilter: verdict,
            offTopicSeries: series,
            ...(threshold
              ? {
                  offTopicFirmAt: firmAt,
                  ...(threshold.ok ? {} : { offTopicFirmAtRead: threshold.reason })
                }
              : {})
          },
          "the local pre-filter answered; no model call"
        );
        const localAnswer = localAnswerFor(verdict.decision, series, firmAt);
        const localMessageId = await conversations.saveMessage({
          conversationId: activeConversationId,
          role: "assistant",
          content: localAnswer,
          model: PREFILTER_MODEL_LABEL
        });

        await noteOutcome(`prefilter_${verdict.decision}`);

        return {
          conversationId: activeConversationId,
          messageId: localMessageId,
          answer: localAnswer,
          doseGuard: null,
          linkGuard: null,
          model: PREFILTER_MODEL_LABEL,
          // Nothing was looked up for this answer, and the surface that judges answers must be able to read that.
          productContext: {
            state: "not_asked",
            hitCount: null,
            projectionVersion: null,
            descriptionSources: []
          },
          ...customerChatFields(resolvedCustomer)
        };
      }
    }

    if (!process.env.OPENAI_API_KEY) {
      await noteOutcome("provider_not_configured");

      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    /**
     * The catalogue, looked up before the model is told anything about it.
     *
     * THE SEARCH AND THE CLAUSE MOVE TOGETHER, and that is the requirement,
     * not a preference: until now the prompt said unconditionally that there
     * is no product data. Wiring the search in without replacing that sentence
     * would leave a state where the model HAS the catalogue in front of it and
     * is told in the same breath that it has none - the two texts sit in one
     * `join`, so they would both be there.
     *
     * The raw question goes over as-is. The OS builds the search expression
     * from it (the brief says so, and `product-search.ts` says the same in
     * other words: how the search works is the OS's business). Turning the
     * question into keywords here would put half the engine on this side.
     *
     * A failure never throws: `searchProducts` reports outcomes, and each one
     * gets its own paragraph in the prompt. An outage must not read like an
     * empty catalogue.
     */
    const productSearch = await searchProducts({ query: message });
    const productContext = productContextInstructions(productSearch);
    /**
     * The same search, in the shape the surface reads.
     *
     * Built from the SAME outcome the prompt was built from, through the same
     * classifier - so "what the model was told" and "what we report it was
     * told" are one claim, not two that can drift.
     */
    const productContextSeen = productContextSummary(productSearch);

    if (!productSearch.ok) {
      request.log.warn(
        { reason: productSearch.error, detail: productSearch.detail },
        "the catalogue search did not run for this answer"
      );
    }

    // WHAT THE MODEL RECEIVES: the current message and the whole history with every e-mail address and Hungarian telephone number
    // replaced (in memory only; the stored rows are unchanged). Done BEFORE the call, on the history the call uses. Only the
    // NUMBER of replacements is logged. Exactly `AI_CHAT_MASK_CONTACTS=false` turns it off.
    const maskingOn = maskContactsEnabled();
    let maskedContacts = 0;
    const modelInput = history.map((item) => {
      if (!maskingOn) return { role: item.role, content: item.content };
      const result = maskContacts(item.content);
      maskedContacts += result.masked;
      return { role: item.role, content: result.text };
    });
    if (maskedContacts > 0)
      request.log.info(
        { maskedContacts },
        "contact data was kept out of the model input"
      );

    const askedAt = Date.now();
    const linkRule = linkRuleMode();
    // the stored link sources (card 9d060f5c), read from the OS while the model works; a failed read is an empty list
    const linkSourcesRead: Promise<LinkSourcesRead> | null =
      linkRule === "off"
        ? null
        : readLinkSources().catch(() => ({ ok: false, sources: [], reason: "unavailable" }) as const);

    try {
      const response = await openai.responses.create({
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        instructions: chatInstructions(resolvedCustomer, productContext, {
          colleagueOfferActive: offerActive,
          contactRequestActive: contactFlow,
          linkRule
        }),
        input: modelInput,
        store: false
      });

      // NO DOSE LEAVES THAT THE MANUFACTURER DID NOT GIVE (Acropora OS card
      // 85c38ab1): every dose statement must be a FIXED dose of a hit; else the
      // customer gets the label-or-colleague sentence. The reason is logged,
      // the model's sentence is not (it may quote the customer).
      const doseGuard = guardAnswerDoses(response.output_text ?? "", productSearch);
      // NO EXTERNAL LINK BY DEFAULT (card 9d060f5c), behind AI_LINK_RULE: `off`
      // runs nothing; `log` reports and leaves the answer; `enforce` replaces it.
      // Read on the model's own text, so a dose fallback does not hide a link.
      const linkSources = linkSourcesRead ? await linkSourcesRead : null;
      if (linkSources && !linkSources.ok)
        request.log.warn(
          { linkSources: linkSources.reason },
          "the stored link sources could not be read; no exception is active for this answer"
        );
      else if (linkSources?.ok && linkSources.dropped > 0)
        request.log.warn(
          { linkSources: { dropped: linkSources.dropped } },
          "stored link sources the gate cannot use were left out"
        );
      const linkGuard =
        linkSources === null
          ? null
          : guardAnswerLinks({
              answer: response.output_text ?? "",
              userMessage: message,
              outcome: productSearch,
              sources: linkSources.sources
            });
      const modelAnswer = !doseGuard.ok
        ? DOSE_GUARD_FALLBACK
        : linkRule === "enforce" && linkGuard && !linkGuard.ok
          ? LINK_GUARD_FALLBACK
          : response.output_text;
      // SLICE 3: after the fourth customer turn, ONE sentence is appended by local logic (no model call of its own). Behind its OWN
      // switch (AI_CHAT_COLLEAGUE_OFFER, off by default) and the gate's. The count is of the history the route loaded, with the message being answered in it.
      const offerColleague =
        offerActive && shouldOfferColleague(customerTurnCount(history));
      if (offerColleague)
        request.log.info(
          { colleagueOffer: true },
          "the colleague offer was appended to the answer"
        );
      // While the contact request is on, the offer asks for the contact (slice 4c/4d) and the row is flagged so the next message is read as its reply.
      const answerText = offerColleague
        ? contactFlow
          ? withContactOffer(modelAnswer)
          : withColleagueOffer(modelAnswer)
        : modelAnswer;
      if (!doseGuard.ok)
        request.log.warn(
          { doseGuard: doseGuard.reason },
          "the answer stated a dose the catalogue does not hold; replaced"
        );
      // The host only, never the URL (it may carry the customer's words).
      if (linkGuard && !linkGuard.ok)
        request.log.warn(
          { linkGuard: { mode: linkRule, reason: linkGuard.reason, hosts: linkGuard.hosts } },
          linkRule === "enforce"
            ? "the answer linked outside our domain; replaced"
            : "the answer linked outside our domain; logged, not replaced"
        );
      // Plan 5.4: own links are counted apart, with how many look like a product page.
      if (linkGuard && linkGuard.ownLinks > 0)
        request.log.info(
          {
            linkGuard: {
              ownLinks: linkGuard.ownLinks,
              ownProductPathLinks: linkGuard.ownProductPathLinks
            }
          },
          "the answer linked our own domain"
        );

      const answerMessageId = await conversations.saveMessage({
        conversationId: activeConversationId,
        role: "assistant",
        content: answerText,
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        usage: readUsage(response),
        ...(offerColleague && contactFlow
          ? { localKind: CONTACT_OFFER_KIND }
          : contactFlow && previousRow?.role === "assistant" && previousRow.localKind === CONTACT_OFFER_KIND
            ? // the model's answer to a message that followed the offer without a contact asks for it (the instruction says so): that
              // answer is flagged for ONE step, so the next message with a contact is read as the reply
              { localKind: CONTACT_ASK_KIND }
            : {})
      });

      await noteOutcome("answered");

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
        answer: answerText,
        /** Why the answer was replaced, if it was: the judging surface reads it. */
        doseGuard: doseGuard.ok ? null : doseGuard.reason,
        /** The link gate's reading (null under `off`): the reason and the hosts, never a URL. */
        linkGuard:
          linkGuard === null
            ? null
            : {
                mode: linkRule,
                reason: linkGuard.reason,
                hosts: linkGuard.hosts,
                ownLinks: linkGuard.ownLinks,
                ownProductPathLinks: linkGuard.ownProductPathLinks
              },
        model: process.env.OPENAI_MODEL ?? "gpt-5.1",
        /**
         * What this answer actually had in front of it.
         *
         * The surface that judges answers used to be handed a fixed sentence
         * saying there was no product context. That sentence stops being true
         * the moment the catalogue is wired in, and it would go on being
         * displayed - confidently, on the one screen where a human decides
         * whether an answer was good. A judgement is only interpretable if the
         * judge can see what the answer was built from.
         */
        productContext: productContextSeen,
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

      await noteOutcome(failure.body.error);

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * The water-measurement product recommendation (Acropora OS card 2b3983e1).
   *
   * The OS server calls it with the shared token, never a browser (the public
   * boundary). Nothing is stored here: the OS keeps the draft, the approved
   * text and the example pairs, and sends the pairs back with each request.
   * The answer's product ids are filtered against the candidates in
   * `guardRecommendationText`, not only asked for in the prompt.
   */
  app.post("/v1/measurement-recommendations", async (request, reply) => {
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

    const parsed = parseRecommendationRequest(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model,
        instructions: MEASUREMENT_RECOMMENDATION_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: measurementRecommendationInput(parsed.request)
          }
        ],
        store: false
      });

      const guarded = guardRecommendationText(
        response.output_text ?? "",
        new Set(parsed.request.candidates.map((c) => c.productId))
      );

      if (guarded.removedProductIds.length) {
        request.log.warn(
          { removed: guarded.removedProductIds.length },
          "the recommendation named products outside the candidates"
        );
      }

      return {
        text: guarded.text,
        model,
        removedProductIds: guarded.removedProductIds
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
        "OpenAI request failed for a measurement recommendation"
      );

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * The manufacturer's dosing from one product page (Acropora OS card 85c38ab1,
   * Product Knowledge). The OS server calls it with the shared token: it sends
   * the page's visible text and the product's name, and gets the dosing state
   * with a verbatim excerpt. The excerpt is checked against the page text here
   * (`guardDosingAnswer`) and again in the OS; nothing is stored here. An answer
   * the guard refuses is a 200 with `refusal`: the OS sends the product to a person.
   */
  app.post("/v1/dosing-extractions", async (request, reply) => {
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

    const parsed = parseDosingRequest(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model,
        instructions: DOSING_EXTRACTION_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: dosingExtractionInput(parsed.request)
          }
        ],
        store: false
      });

      const guarded = guardDosingAnswer(
        response.output_text ?? "",
        parsed.request.pageText
      );

      if (!guarded.ok) {
        request.log.warn(
          { refusal: guarded.refusal, detail: guarded.detail },
          "the dosing answer was refused by the guard"
        );
        // the detail is counts and a character code, never page text
        return {
          refusal: guarded.refusal,
          ...(guarded.detail ? { refusalDetail: guarded.detail } : {}),
          model
        };
      }

      return { ...guarded.answer, model };
    } catch (error) {
      const failure = aiProviderFailure(error, Date.now() - askedAt);

      request.log.error(
        {
          aiProviderError: safeErrorSummary(error),
          aiProviderOutcome: failure.body.error,
          waitedMs: failure.body.waitedMs,
          timeoutMs: limits.timeoutMs
        },
        "OpenAI request failed for a dosing extraction"
      );

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * Candidate claims from one scientific text, field by field, every value on
   * a verbatim anchor (Acropora OS research knowledge base, S3). The OS server
   * calls it with the shared token: it sends the text (an open-access full
   * text it downloaded), the subject and the vocabulary keys it accepts. The
   * passage and every anchor are checked against the text here
   * (`guardClaims`) and again in the OS; nothing is stored here. A model
   * answer the guard cannot read is a 200 with `refusal`.
   */
  app.post("/v1/claim-extractions", async (request, reply) => {
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

    const parsed = parseClaimRequest(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
    const extractedBy = `${model} ${CLAIM_EXTRACTION_PROMPT_VERSION}`;
    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model,
        instructions: claimExtractionInstructions(parsed.request),
        input: [
          {
            role: "user",
            content: claimExtractionInput(parsed.request)
          }
        ],
        // one valid JSON object, enforced by the provider: on stage (2026-10-31)
        // six answers of four sources were valid JSON up to a second "{"
        text: CLAIMS_AS_JSON,
        store: false
      });

      // a cut answer is told apart from a broken one: its end is not the model's
      const incomplete =
        response.status === "incomplete" ? (response.incomplete_details?.reason ?? "unknown") : null;
      const guarded = guardClaims(response.output_text ?? "", parsed.request, incomplete);

      if (!guarded.ok) {
        // the detail is counts and a code point, never the answer's text
        request.log.warn(
          { refusal: guarded.refusal, detail: guarded.detail },
          "the claim extraction answer was refused by the guard"
        );
        return { refusal: guarded.refusal, detail: guarded.detail, extractedBy };
      }

      // counts only in the log: the claims carry text of the source
      request.log.info(
        {
          claims: guarded.claims.length,
          refusedClaims: guarded.refusedClaims.length,
          fields: guarded.claims.reduce((n, c) => n + c.fields.length, 0),
          refusedFields: guarded.claims.reduce((n, c) => n + c.refusedFields.length, 0),
          questions: guarded.claims.reduce((n, c) => n + c.questions.length, 0)
        },
        "claim extraction guarded"
      );
      return { claims: guarded.claims, refusedClaims: guarded.refusedClaims, extractedBy };
    } catch (error) {
      const failure = aiProviderFailure(error, Date.now() - askedAt);

      request.log.error(
        {
          aiProviderError: safeErrorSummary(error),
          aiProviderOutcome: failure.body.error,
          waitedMs: failure.body.waitedMs,
          timeoutMs: limits.timeoutMs
        },
        "OpenAI request failed for a claim extraction"
      );

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * Candidate claims from one figure: its caption and its image tiles
   * (research-kepes-ut). Its own call, not an image on the text extraction:
   * the model writes the image's printed text out (a transcript per tile), and
   * every passage and anchor must stand in the caption or a transcript; each
   * claim says which (`origin`), because only the caption is a text the OS can
   * check verbatim (`figure-claim-extraction.ts`). The body carries the images,
   * so it has its own size limit, and the token is checked BEFORE the body is
   * read (`onRequest`): otherwise a caller without a token could make this
   * service read and parse 33 MiB per request (barracuda, ai#59). Nothing is
   * stored here.
   */
  app.post(
    "/v1/figure-claim-extractions",
    {
      bodyLimit: FIGURE_BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (!tokenIsValid(request.headers.authorization))
          return reply.code(401).send({ error: "unauthorized" });
      }
    },
    async (request, reply) => {
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

      const parsed = parseFigureRequest(request.body);

      if (!parsed.ok) {
        return reply.code(400).send({
          error: parsed.error
        });
      }

      if (!process.env.OPENAI_API_KEY) {
        return reply.code(503).send({
          error: "AI provider is not configured"
        });
      }

      const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
      const extractedBy = `${model} ${FIGURE_CLAIM_EXTRACTION_PROMPT_VERSION}`;
      const askedAt = Date.now();

      try {
        const response = await openai.responses.create({
          model,
          instructions: figureClaimInstructions(parsed.request),
          input: figureClaimInput(parsed.request),
          text: CLAIMS_AS_JSON,
          store: false
        });

        const incomplete =
          response.status === "incomplete" ? (response.incomplete_details?.reason ?? "unknown") : null;
        const guarded = guardFigureClaims(response.output_text ?? "", parsed.request, incomplete);

        if (!guarded.ok) {
          // the detail is counts and a code point, never the answer's text
          request.log.warn(
            { refusal: guarded.refusal, detail: guarded.detail },
            "the figure claim extraction answer was refused by the guard"
          );
          return { refusal: guarded.refusal, detail: guarded.detail, extractedBy };
        }

        // counts only in the log: the claims and transcripts carry the source's text
        request.log.info(
          {
            images: parsed.request.images.length,
            claims: guarded.claims.length,
            fromImage: guarded.claims.filter((c) => c.origin.part === "IMAGE").length,
            fromReading: guarded.claims.filter((c) => c.origin.part === "READING").length,
            refusedClaims: guarded.refusedClaims.length,
            transcriptChars: guarded.transcripts.reduce((n, t) => n + t.length, 0),
            readingChars: guarded.readings.reduce((n, t) => n + t.length, 0)
          },
          "figure claim extraction guarded"
        );
        return {
          claims: guarded.claims,
          refusedClaims: guarded.refusedClaims,
          transcripts: guarded.transcripts,
          readings: guarded.readings,
          extractedBy
        };
      } catch (error) {
        const failure = aiProviderFailure(error, Date.now() - askedAt);

        request.log.error(
          {
            aiProviderError: safeErrorSummary(error),
            aiProviderOutcome: failure.body.error,
            waitedMs: failure.body.waitedMs,
            timeoutMs: limits.timeoutMs
          },
          "OpenAI request failed for a figure claim extraction"
        );

        return reply.code(failure.status).send(failure.body);
      }
    }
  );

  /**
   * An answer from accepted knowledge only (Acropora OS research knowledge
   * base, S6 mode A, internal pilot). The OS server calls it with the shared
   * token: the question, the claims it may be answered from (each one finished
   * sentence) and its fixed sentences. The model selects and orders; the guard
   * keeps a sentence only if it IS a statement sent (or a fixed sentence) and
   * writes the [[claim:id]] marker itself. The OS gates the result again;
   * nothing is stored here. A model answer the guard cannot read is a 200 with
   * `refusal`.
   */
  app.post("/v1/knowledge-answers", async (request, reply) => {
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

    const parsed = parseKnowledgeAnswerRequest(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
    const answeredBy = `${model} ${KNOWLEDGE_ANSWER_PROMPT_VERSION}`;
    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model,
        instructions: knowledgeAnswerInstructions(),
        input: [
          {
            role: "user",
            content: knowledgeAnswerInput(parsed.request)
          }
        ],
        store: false
      });

      const guarded = guardKnowledgeAnswer(response.output_text ?? "", parsed.request);

      if (!guarded.ok) {
        request.log.warn({ refusal: guarded.refusal }, "the knowledge answer was refused by the guard");
        return { refusal: guarded.refusal, answeredBy };
      }

      // counts and codes only: the question is the user's text
      request.log.info(
        {
          sentences: guarded.sentences.length,
          cited: guarded.sentences.filter((s) => s.claimId !== null).length,
          refused: guarded.refused.map((r) => r.refusal)
        },
        "knowledge answer guarded"
      );
      return { answer: guarded.answer, sentences: guarded.sentences, refused: guarded.refused, answeredBy };
    } catch (error) {
      const failure = aiProviderFailure(error, Date.now() - askedAt);

      request.log.error(
        {
          aiProviderError: safeErrorSummary(error),
          aiProviderOutcome: failure.body.error,
          waitedMs: failure.body.waitedMs,
          timeoutMs: limits.timeoutMs
        },
        "OpenAI request failed for a knowledge answer"
      );

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * Mode B, step 1 (Acropora OS research knowledge base, S6, editor only):
   * the editor's Hungarian question as at most three English search
   * expressions. The guard keeps only the search syntax; the OS sends them to
   * the literature APIs. Nothing is stored here.
   */
  app.post("/v1/research-queries", async (request, reply) => {
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

    const parsed = parseResearchQuestion(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
    const writtenBy = `${model} ${RESEARCH_QUERIES_PROMPT_VERSION}`;
    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model,
        instructions: researchQueriesInstructions(),
        input: [
          {
            role: "user",
            content: JSON.stringify({ question: parsed.question })
          }
        ],
        store: false
      });

      const guarded = guardResearchQueries(response.output_text ?? "");

      if (!guarded.ok) {
        request.log.warn({ refusal: guarded.refusal }, "the research queries was refused by the guard");
        return { refusal: guarded.refusal, writtenBy };
      }

      // counts and codes only: the question is the editor's text
      request.log.info({ queries: guarded.queries.length, refused: guarded.refused.map((r) => r.refusal) }, "the research queries guarded");
      return { queries: guarded.queries, refused: guarded.refused, writtenBy };
    } catch (error) {
      const failure = aiProviderFailure(error, Date.now() - askedAt);

      request.log.error(
        {
          aiProviderError: safeErrorSummary(error),
          aiProviderOutcome: failure.body.error,
          waitedMs: failure.body.waitedMs,
          timeoutMs: limits.timeoutMs
        },
        "OpenAI request failed for the research queries"
      );

      return reply.code(failure.status).send(failure.body);
    }
  });

  /**
   * Mode B, step 4 (S6, editor only): a Hungarian summary written ONLY from
   * the candidate claims the OS extracted and checked. Every sentence must
   * carry markers of claims sent, and every number in it must be a number of
   * the claims it cites; the rest is dropped with its reason. The OS stores
   * the result as a research DRAFT, marked as model text. Nothing is stored
   * here.
   */
  app.post("/v1/research-summaries", async (request, reply) => {
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

    const parsed = parseSummaryRequest(request.body);

    if (!parsed.ok) {
      return reply.code(400).send({
        error: parsed.error
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({
        error: "AI provider is not configured"
      });
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-5.1";
    const writtenBy = `${model} ${RESEARCH_SUMMARY_PROMPT_VERSION}`;
    const askedAt = Date.now();

    try {
      const response = await openai.responses.create({
        model,
        instructions: researchSummaryInstructions(),
        input: [
          {
            role: "user",
            content: researchSummaryInput(parsed.request)
          }
        ],
        store: false
      });

      const guarded = guardResearchSummary(response.output_text ?? "", parsed.request);

      if (!guarded.ok) {
        request.log.warn({ refusal: guarded.refusal }, "the research summary was refused by the guard");
        return { refusal: guarded.refusal, writtenBy };
      }

      // counts and codes only: the question is the editor's text
      request.log.info(
        { kept: guarded.kept, dropped: guarded.dropped.map((d) => d.drop), markersMoved: guarded.markersMoved },
        "the research summary guarded"
      );
      return {
        summary: guarded.summary,
        kept: guarded.kept,
        dropped: guarded.dropped,
        markersMoved: guarded.markersMoved,
        writtenBy
      };
    } catch (error) {
      const failure = aiProviderFailure(error, Date.now() - askedAt);

      request.log.error(
        {
          aiProviderError: safeErrorSummary(error),
          aiProviderOutcome: failure.body.error,
          waitedMs: failure.body.waitedMs,
          timeoutMs: limits.timeoutMs
        },
        "OpenAI request failed for a research summary"
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
      axis?: unknown;
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

    const axis = request.body?.axis;

    if (!isRatingAxis(axis)) {
      /**
       * The axis is required, with no default.
       *
       * Defaulting to `accuracy` would be the convenient choice and the wrong
       * one: a caller that forgot the field would silently file a judgement
       * about wording as a judgement about facts, and nothing downstream could
       * tell the difference afterwards.
       */
      return reply.code(400).send({
        error: "invalid axis",
        allowed: RATING_AXES
      });
    }

    const rating = request.body?.rating;

    if (!isRatingForAxis(axis, rating)) {
      /**
       * The accepted values travel with the refusal, and they are the values
       * OF THIS AXIS.
       *
       * A bare "invalid rating" would leave the caller guessing at a list that
       * lives in two repositories, and the surface in front is written by
       * somebody who cannot read this file. Answering with the whole
       * vocabulary of both axes would be worse than useless here: it would
       * suggest that `natural` is a thing to send about facts.
       */
      return reply.code(400).send({
        error: "invalid rating",
        axis,
        allowed: RATINGS_BY_AXIS[axis]
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
    if (clientKey === null) return reply.code(400).send({ error: INVALID_CLIENT_KEY });

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
      axis,
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
    if (clientKey === null) return reply.code(400).send({ error: INVALID_CLIENT_KEY });

    return {
      conversationId,
      ratings: await ratings.conversationRatings(conversationId, clientKey)
    };
  });

  return app;
}
