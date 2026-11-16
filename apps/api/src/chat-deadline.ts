import type { FastifyReply } from "fastify";

/**
 * THE CHAT ANSWER'S OWN DEADLINE, UNDER THE CONNECTION NET (acrobot 53996, task t-20261116-ai-kezelo-hatarido).
 *
 * The net (`connectionTimeout`, 45 s) closes a handler that is still working, with no HTTP answer: the OS chat then
 * showed an empty failure ("ai_unreachable") and the question-set runner died on "other side closed". The model call
 * gives up at 40 s on its own, but the net counts the WHOLE handler: the product search, the link sources, the model and
 * the writes. This deadline counts the whole handler too, and answers before the net does, with a code the OS can name.
 *
 * Two seconds under the net, not five: the model limit stays at 40 s (acrobot's decision), and a deadline at 40 s would
 * fire before the model's own, named timeout whenever anything at all ran before the call. At 43 s the model's own
 * `ai_provider_timeout` still answers a slow model, and this one answers what nothing else did: the time spent around it.
 */
export const CHAT_DEADLINE_MARGIN_MS = 2_000;

/** The shortest deadline: a net set very low in a test still leaves the handler a moment to answer. */
const MINIMUM_CHAT_DEADLINE_MS = 500;

export function chatDeadlineMs(connectionTimeoutMs: number): number {
  return Math.max(MINIMUM_CHAT_DEADLINE_MS, connectionTimeoutMs - CHAT_DEADLINE_MARGIN_MS);
}

/** What the caller is told: a code, and how long it waited. The OS turns the code into a sentence. */
export const CHAT_DEADLINE_ERROR = "ai_chat_deadline";

export interface ChatDeadline {
  /** True once the answer has been sent: the handler must not store an answer nobody will see. */
  expired(): boolean;
  /** Aborted at the deadline, so a model call still running stops costing. */
  signal: AbortSignal;
}

const EXPIRED = Symbol("expired");

/**
 * Runs the handler against the deadline. If the deadline comes first, the caller gets 504 `ai_chat_deadline` at once;
 * the handler is not killed (nothing in JavaScript can be), it is told through `expired()` and `signal`, and its own
 * result is dropped. A rejection that arrives after the answer was sent is swallowed here: the 504 already went out.
 */
export async function withChatDeadline<T>(
  reply: FastifyReply,
  deadlineMs: number,
  handler: (deadline: ChatDeadline) => Promise<T>
): Promise<T | FastifyReply> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(EXPIRED);
    }, deadlineMs);
  });
  const work = handler({ expired: () => controller.signal.aborted, signal: controller.signal });

  try {
    const first = await Promise.race([work, expiry]);
    if (first !== EXPIRED) return first;
    work.catch(() => undefined);
    const waitedMs = Date.now() - startedAt;
    reply.log.warn(
      { chatDeadline: { deadlineMs, waitedMs } },
      "the chat answer ran past its deadline; answered 504 before the connection net"
    );
    if (!reply.sent) return reply.code(504).send({ error: CHAT_DEADLINE_ERROR, waitedMs });
    return reply;
  } finally {
    clearTimeout(timer);
  }
}
