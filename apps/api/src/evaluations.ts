import { pool } from "./db.js";

/**
 * An answer is judged on TWO independent axes, and they never mix.
 *
 * The reason is a case that a single list cannot express: an answer can be
 * factually right and written in unreadable Hungarian, or fluent and wrong.
 * Folded into one set of buttons those two collapse into each other, and the
 * distinction is exactly what the measurement is for.
 *
 * Independent also means separately absent: someone may judge the wording and
 * leave the facts alone, or the other way round. Nothing here requires a pair.
 */
export const RATING_AXES = ["accuracy", "language"] as const;

export type RatingAxis = (typeof RATING_AXES)[number];

/**
 * The four judgements about the FACTS, in the keys the surface uses.
 *
 * Balazs specified them on the screen, and they are stored unchanged: a
 * mapping between a button and a database value is a place where the two
 * drift apart, and the drift is silent - the numbers keep adding up, they
 * just stop meaning what the screen said.
 */
export const ACCURACY_RATINGS = [
  "correct",
  "inaccurate",
  "dangerous",
  "no-data"
] as const;

/**
 * The four judgements about the WORDING, and deliberately not a copy of the
 * accuracy set.
 *
 * Same shape, because it has to be used the same way - one click, no
 * deliberation: one good value and three kinds of failure, of which one is
 * heavier than the others.
 *
 * - `natural`   - reads as a Hungarian professional would say it.
 * - `wordy`     - true, but the answer cannot be read out of it quickly.
 * - `foreign`   - translated-sounding: English word order and phrases nobody
 *                 says in Hungarian.
 * - `confusing` - the WORDING allows a different reading than what is meant.
 *                 This is the wording equivalent of `dangerous`: the other
 *                 three are unpleasant, this one turns a factually correct
 *                 answer into a wrong action.
 *
 * Tone (condescending, over-familiar, bureaucratic) was deliberately left
 * out. It matters for the brand voice, but as a fifth button it would dilute
 * the list, and three of these four already depend on it indirectly. Adding
 * it later should be a decision, not an afterthought.
 */
export const LANGUAGE_RATINGS = [
  "natural",
  "wordy",
  "foreign",
  "confusing"
] as const;

export const RATINGS_BY_AXIS = {
  accuracy: ACCURACY_RATINGS,
  language: LANGUAGE_RATINGS
} as const satisfies Record<RatingAxis, readonly string[]>;

export type AccuracyRating = (typeof ACCURACY_RATINGS)[number];
export type LanguageRating = (typeof LANGUAGE_RATINGS)[number];
export type RatingValue = AccuracyRating | LanguageRating;

export function isRatingAxis(value: unknown): value is RatingAxis {
  return (
    typeof value === "string" &&
    (RATING_AXES as readonly string[]).includes(value)
  );
}

/**
 * Is this value allowed ON THIS AXIS?
 *
 * Asked per axis rather than globally, because "is it one of the eight" would
 * accept `natural` as a judgement about facts. The values are not
 * interchangeable, and a validator that treats them as one pool would let the
 * two lists quietly merge - which is the thing the split exists to prevent.
 */
export function isRatingForAxis(
  axis: RatingAxis,
  value: unknown
): value is RatingValue {
  return (
    typeof value === "string" &&
    (RATINGS_BY_AXIS[axis] as readonly string[]).includes(value)
  );
}

export interface StoredRating {
  messageId: string;
  axis: RatingAxis;
  rating: RatingValue;
  ratedBy: string;
  ratedAt: string;
}

/**
 * Is this answer one the caller is allowed to judge?
 *
 * Two conditions, and both matter. The message has to belong to a conversation
 * of this client - the same ownership rule the chat route applies, because a
 * rating endpoint that skips it would let any holder of the shared token write
 * against message ids it never saw. And the message has to be an ANSWER: a
 * rating on one's own question is not a data point about the model, and
 * storing it would quietly pollute whatever gets counted later.
 */
export async function answerIsRatable(
  messageId: string,
  clientKey: string
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM messages
      JOIN conversations ON conversations.id = messages.conversation_id
      WHERE messages.id = $1
        AND messages.role = 'assistant'
        AND conversations.client_key = $2
    `,
    [messageId, clientKey]
  );

  return result.rowCount === 1;
}

/**
 * Writes the judgement, or replaces the one this person gave before ON THIS
 * AXIS.
 *
 * An upsert rather than an insert, because on the screen the buttons of one
 * axis are a single choice: pressing another one is a correction, not a
 * second opinion. Three things stay separate rows, and each for its own
 * reason: two different people judging the same answer (disagreement is a
 * finding), and one person judging the same answer on both axes (the facts
 * and the wording are different questions).
 */
export async function rateAnswer(input: {
  messageId: string;
  axis: RatingAxis;
  rating: RatingValue;
  ratedBy: string;
}): Promise<StoredRating> {
  const result = await pool.query<{
    message_id: string;
    axis: RatingAxis;
    rating: RatingValue;
    rated_by: string;
    updated_at: Date;
  }>(
    `
      INSERT INTO answer_ratings (message_id, axis, rating, rated_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (message_id, rated_by, axis)
      DO UPDATE SET
        rating = EXCLUDED.rating,
        updated_at = NOW()
      RETURNING message_id, axis, rating, rated_by, updated_at
    `,
    [input.messageId, input.axis, input.rating, input.ratedBy]
  );

  const row = result.rows[0];

  return {
    messageId: row.message_id,
    axis: row.axis,
    rating: row.rating,
    ratedBy: row.rated_by,
    ratedAt: row.updated_at.toISOString()
  };
}

/**
 * What has been said about the answers in one conversation.
 *
 * The surface needs it to show a rating that was given before the page was
 * reloaded - which is the reason any of this is stored rather than kept in
 * the browser.
 */
export async function conversationRatings(
  conversationId: string,
  clientKey: string
): Promise<StoredRating[]> {
  const result = await pool.query<{
    message_id: string;
    axis: RatingAxis;
    rating: RatingValue;
    rated_by: string;
    updated_at: Date;
  }>(
    `
      SELECT
        answer_ratings.message_id,
        answer_ratings.axis,
        answer_ratings.rating,
        answer_ratings.rated_by,
        answer_ratings.updated_at
      FROM answer_ratings
      JOIN messages ON messages.id = answer_ratings.message_id
      JOIN conversations ON conversations.id = messages.conversation_id
      WHERE conversations.id = $1
        AND conversations.client_key = $2
      ORDER BY answer_ratings.updated_at ASC
    `,
    [conversationId, clientKey]
  );

  return result.rows.map((row) => ({
    messageId: row.message_id,
    axis: row.axis,
    rating: row.rating,
    ratedBy: row.rated_by,
    ratedAt: row.updated_at.toISOString()
  }));
}
