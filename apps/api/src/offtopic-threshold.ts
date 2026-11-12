import { CHAT_SETTINGS_PATH, chatSettingsConfig, requestChatSettings } from "./chat-settings.js";
import { OFFTOPIC_SERIES_FIRM_AT } from "./request-prefilter-turns.js";

/**
 * THE OFF-TOPIC SERIES THRESHOLD, READ FROM THE ACROPORA OS (card f5b8f7ba; Balázs 2026-11-11 08:51: 5, settable in the
 * Settings). The OS keeps it next to the other AI chat settings and hands it out on the same reader endpoint, through the same
 * client and token as the retention days and the link sources (`chat-settings.ts`, `requestChatSettings`). Only the
 * `offTopicFirmAt` field is read here.
 *
 * EVERY FAILURE READS AS THE DEFAULT, 5, and that direction is safe: the number only picks which of two local texts an off-topic
 * question gets, it deletes nothing and lets nothing out, and 5 is Balázs's own value. An OS before the field existed answers
 * without it; that is the default too, not a broken answer. The failure is reported to the caller (for the log), never thrown.
 *
 * The value is trusted only within the OS's own bounds (`AI_CHAT_SETTINGS_LIMITS.offTopicFirmAt`, 2 to 20, a whole number):
 * anything else is the default, never a value moved to the nearest legal one.
 */

export const OFFTOPIC_THRESHOLD_PATH = CHAT_SETTINGS_PATH;

/** The same bounds the OS enforces; a value outside them is not trusted. */
export const OFFTOPIC_THRESHOLD_MIN = 2;
export const OFFTOPIC_THRESHOLD_MAX = 20;

/** A settings read on an off-topic turn only: a short wait, the local answer does not need the model. */
export const OFFTOPIC_THRESHOLD_TIMEOUT_MS = 3_000;

/** Changed by hand, rarely: one read a minute is enough. */
export const OFFTOPIC_THRESHOLD_CACHE_MS = 60_000;

/**
 * A FAILED READ IS KEPT TEN SECONDS (barracuda on #82, acrobot 49052 and 49057): while the OS is down every off-topic turn would
 * otherwise wait for the timeout again before its local answer. It holds the LAST GOOD value of this process, or 5 if there was none.
 */
export const OFFTOPIC_THRESHOLD_FAILURE_CACHE_MS = 10_000;

export type OffTopicThresholdRead =
  | { ok: true; firmAt: number; source: "os" | "os_without_field" }
  | {
      ok: false;
      firmAt: number;
      reason: "not_configured" | "unauthorized" | "unavailable" | "bad_response";
    };

export interface OffTopicThresholdOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: number;
}

let cache: { until: number; read: OffTopicThresholdRead } | null = null;
/** The last value the OS gave in this process: what a failed read holds, before the default. */
let lastGood: number | null = null;

/** For the specs: the next read goes to the OS, and nothing was read before. */
export function clearOffTopicThresholdCache(): void {
  cache = null;
  lastGood = null;
}

const fallback = (reason: Extract<OffTopicThresholdRead, { ok: false }>["reason"]): OffTopicThresholdRead => ({
  ok: false,
  firmAt: lastGood ?? OFFTOPIC_SERIES_FIRM_AT,
  reason
});

/** The threshold, from the OS or the last read: a good one for a minute, a failed one (the last good value, or 5) for ten seconds. */
export async function readOffTopicThreshold(options: OffTopicThresholdOptions = {}): Promise<OffTopicThresholdRead> {
  const now = options.now ?? Date.now();
  if (cache && now < cache.until) return cache.read;

  const config = chatSettingsConfig(options.environment ?? process.env);
  if (!config) return fallback("not_configured");

  const read = await readFromOs(config, options);
  if (read.ok) lastGood = read.firmAt;
  cache = { until: now + (read.ok ? OFFTOPIC_THRESHOLD_CACHE_MS : OFFTOPIC_THRESHOLD_FAILURE_CACHE_MS), read };
  return read;
}

async function readFromOs(
  config: NonNullable<ReturnType<typeof chatSettingsConfig>>,
  options: OffTopicThresholdOptions
): Promise<OffTopicThresholdRead> {
  const answer = await requestChatSettings({
    config,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? OFFTOPIC_THRESHOLD_TIMEOUT_MS
  });
  if (!answer.ok) return fallback(answer.error === "chat_settings_unauthorized" ? "unauthorized" : "unavailable");

  const body = answer.body as { offTopicFirmAt?: unknown } | null;
  if (!body || typeof body !== "object") return fallback("bad_response");
  if (body.offTopicFirmAt === undefined) return { ok: true, firmAt: OFFTOPIC_SERIES_FIRM_AT, source: "os_without_field" };
  const value = body.offTopicFirmAt;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < OFFTOPIC_THRESHOLD_MIN ||
    value > OFFTOPIC_THRESHOLD_MAX
  )
    return fallback("bad_response");
  return { ok: true, firmAt: value, source: "os" };
}
