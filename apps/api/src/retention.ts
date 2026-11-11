import {
  chatSettingsConfig,
  fetchChatSettings,
  type ChatSettingsErrorCode
} from "./chat-settings.js";
import { loadLastKnown, saveLastKnown } from "./chat-settings-store.js";

/**
 * THE RETENTION OF CHAT MESSAGES (Acropora OS card f5b8f7ba, slice 4b; plan `exchange-out/ai-eloszures-4-szelet-terv-2026-11-11.md`,
 * doc-APPROVE barracuda 2026-11-11 10:24 on the v5 package).
 *
 * UNTIL THIS FILE THE SERVICE KEPT EVERY MESSAGE FOR EVER (measured on main 4de6305: no retention rule, no delete). A customer who
 * types a telephone number into the chat leaves it in `messages` for as long as the database lives. This is a daily job that deletes
 * what is older than N days.
 *
 * OFF BY DEFAULT. The default N (180 days) is a PROPOSAL awaiting Balázs, and a job that deletes data must not start on a proposal:
 * `AI_CHAT_RETENTION` exactly `true` turns it on, and `AI_CHAT_MESSAGE_RETENTION_DAYS` sets N (empty means 180). Until slice 4a the
 * value comes from the environment; after it, from the OS Settings.
 *
 * A VALUE THE JOB DOES NOT TRUST MAKES IT SKIP, NEVER GUESS. The plan's rule (barracuda 1): a deleting job's safe side is the MISSED
 * run, not the shorter time. An N that is not a whole number, or lies outside 7..365, is not clamped to the nearest legal value
 * (clamping 1000 to 365 would delete what the owner asked to keep): the run is skipped and the reason logged.
 *
 * THE QUALITY EVIDENCE OUTLIVES THE TEXT. Ratings (`answer_ratings`) go with their message (ON DELETE CASCADE, measured in `db.ts`).
 * Before that, the counts of the ratings about to go are added to `rating_aggregates` (month, axis, rating, count: no text, no
 * identifier), IN THE SAME TRANSACTION as the delete, so a failure rolls both back and a re-run cannot count a rating twice.
 *
 * NOTHING BUT NUMBERS IS LOGGED: how many messages, conversations and ratings went. A log line made of message content would
 * recreate the thing this job removes.
 */

export const RETENTION_ENV = "AI_CHAT_RETENTION";
export const RETENTION_DAYS_ENV = "AI_CHAT_MESSAGE_RETENTION_DAYS";

/** The proposed default, and the bounds the setting may take (a typo of 0 must not delete everything at once). */
export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 365;

export type RetentionConfig =
  | { run: false; reason: "switch_off" }
  | { run: false; reason: "invalid_days" }
  | { run: true; days: number };

export function retentionConfig(
  env: NodeJS.ProcessEnv = process.env
): RetentionConfig {
  if (env[RETENTION_ENV] !== "true") return { run: false, reason: "switch_off" };

  const raw = (env[RETENTION_DAYS_ENV] ?? "").trim();
  if (raw === "") return { run: true, days: DEFAULT_RETENTION_DAYS };
  if (!/^\d+$/.test(raw)) return { run: false, reason: "invalid_days" };

  const days = Number(raw);
  if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS)
    return { run: false, reason: "invalid_days" };

  return { run: true, days };
}

/** Just what the job needs of a `pg` client, so a test can hand in a recording one. */
export interface RetentionClient {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  release(): void;
}

export interface RetentionPool {
  connect(): Promise<RetentionClient>;
}

export interface RetentionResult {
  messages: number;
  conversations: number;
  ratingsAggregated: number;
}

/** Any fixed number: two instances of the service must not run the job at once. */
export const ADVISORY_LOCK_KEY = 4_815_162_342;

/**
 * Rows are older than the cutoff when `created_at < cutoff`: a row exactly N days old STAYS, the next second it goes.
 * The three statements are in one transaction, aggregation BEFORE the delete.
 *
 * THE MONTH IS THE UTC MONTH, SAID IN THE SQL: `date_trunc('month', timestamptz)` uses the SESSION's time zone, so the same row
 * would land in a different month on a database set to Europe/Budapest (measured against a real Postgres: a message at
 * 2026-09-30 23:00 UTC was counted in October).
 */
export const AGGREGATE_RATINGS_SQL = `
  INSERT INTO rating_aggregates (month, axis, rating, ratings)
  SELECT date_trunc('month', m.created_at AT TIME ZONE 'UTC')::date, r.axis, r.rating, COUNT(*)::int
  FROM answer_ratings r
  JOIN messages m ON m.id = r.message_id
  WHERE m.created_at < $1
  GROUP BY 1, 2, 3
  ON CONFLICT (month, axis, rating)
  DO UPDATE SET ratings = rating_aggregates.ratings + EXCLUDED.ratings
`;

export const DELETE_MESSAGES_SQL = `DELETE FROM messages WHERE created_at < $1`;

/**
 * A conversation goes only when it is OLD and EMPTY: a conversation just created (no message saved yet) is young, and one with a
 * message newer than the cutoff still has that message.
 */
export const DELETE_CONVERSATIONS_SQL = `
  DELETE FROM conversations c
  WHERE c.updated_at < $1
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
`;

/** `null` means another instance holds the lock: nothing was done. */
export async function runRetentionOnce(
  pool: RetentionPool,
  now: Date,
  days: number
): Promise<RetentionResult | null> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const lock = await client.query(
        "SELECT pg_try_advisory_xact_lock($1) AS locked",
        [ADVISORY_LOCK_KEY]
      );
      if (lock.rows[0]?.locked !== true) {
        await client.query("ROLLBACK");
        return null;
      }

      const aggregated = await client.query(AGGREGATE_RATINGS_SQL, [cutoff]);
      const messages = await client.query(DELETE_MESSAGES_SQL, [cutoff]);
      const conversations = await client.query(DELETE_CONVERSATIONS_SQL, [cutoff]);
      await client.query("COMMIT");

      return {
        messages: messages.rowCount ?? 0,
        conversations: conversations.rowCount ?? 0,
        ratingsAggregated: aggregated.rowCount ?? 0
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export type RetentionDays =
  | { days: number; origin: "os" | "last_known" | "env"; note?: ChatSettingsErrorCode }
  | { skip: "switch_off" | "invalid_days" | "settings_unavailable"; note?: ChatSettingsErrorCode };

/**
 * WHERE THE DAYS COME FROM (plan 2/1, barracuda 1 and acrobot 46747). The switch is the master: not exactly `true`, nothing runs.
 * With the OS reachable the days are the OS's setting (and each successful read is kept as the LAST KNOWN VALUE). When the OS does
 * not answer, or answers with something the contract does not allow, the job runs on the last value it read; with none, it SKIPS
 * and says so. It never falls back to a code default: a default of 180 would delete what a setting of 365 keeps, and the safe side
 * of a deleting job is the missed run, not the shorter time. When no OS source is configured at all (no token), the days come from
 * the environment as before.
 */
export async function resolveRetentionDays(
  pool: RetentionPool,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch
): Promise<RetentionDays> {
  if (env[RETENTION_ENV] !== "true") return { skip: "switch_off" };

  const source = chatSettingsConfig(env);
  if (!source) {
    const config = retentionConfig(env);
    return config.run
      ? { days: config.days, origin: "env" }
      : { skip: config.reason };
  }

  const read = await fetchChatSettings({ config: source, fetchImpl });
  const client = await pool.connect();
  try {
    if (read.ok) {
      // A failure to KEEP the value does not stop a run that has a fresh one.
      await saveLastKnown(client, read.view).catch(() => undefined);
      return { days: read.view.messageRetentionDays, origin: "os" };
    }
    const known = await loadLastKnown(client).catch(() => null);
    return known
      ? { days: known.messageRetentionDays, origin: "last_known", note: read.error }
      : { skip: "settings_unavailable", note: read.error };
  } finally {
    client.release();
  }
}

export interface RetentionLog {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/** One pass of the job as the scheduler runs it: config, run, and a log line of numbers and reason codes only. */
export async function retentionPass(
  pool: RetentionPool,
  log: RetentionLog,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  fetchImpl?: typeof fetch
): Promise<void> {
  const resolved = await resolveRetentionDays(pool, env, fetchImpl);
  if ("skip" in resolved) {
    // A switched-off job is silent; a skipped one (a value it does not trust, or no value at all) is named.
    if (resolved.skip !== "switch_off")
      log.error(
        {
          retention: "retention_skipped",
          reason: resolved.skip,
          ...(resolved.note ? { settings: resolved.note } : {})
        },
        "retention run skipped"
      );
    return;
  }

  try {
    const result = await runRetentionOnce(pool, now, resolved.days);
    if (result === null)
      log.info({ retention: "retention_skipped", reason: "locked" }, "retention run skipped");
    else
      log.info(
        {
          retention: {
            days: resolved.days,
            origin: resolved.origin,
            ...(resolved.note ? { settings: resolved.note } : {}),
            ...result
          }
        },
        "retention run finished"
      );
  } catch (error) {
    // The error object is not handed to the logger: its message can carry a row value. The code is enough to find the cause.
    const code = (error as { code?: unknown } | null)?.code;
    log.error(
      { retention: "retention_failed", code: typeof code === "string" ? code : null },
      "retention run failed"
    );
  }
}

/** Starts the daily job. The first pass runs at once, then every 24 hours. The timer does not keep the process alive. */
export function startRetention(
  pool: RetentionPool,
  log: RetentionLog,
  env: NodeJS.ProcessEnv = process.env,
  intervalMs: number = 24 * 60 * 60 * 1000
): () => void {
  void retentionPass(pool, log, env);
  const timer = setInterval(() => void retentionPass(pool, log, env), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
