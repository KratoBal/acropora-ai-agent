import { pool } from "./db.js";

/**
 * The four judgements the internal test surface offers, in its own keys.
 *
 * Balazs specified them on the screen, and they are stored unchanged: a
 * mapping between a button and a database value is a place where the two
 * drift apart, and the drift is silent - the numbers keep adding up, they
 * just stop meaning what the screen said.
 */
export const RATING_VALUES = [
  "correct",
  "inaccurate",
  "dangerous",
  "no-data"
] as const;

export type RatingValue = (typeof RATING_VALUES)[number];

export function isRatingValue(value: unknown): value is RatingValue {
  return (
    typeof value === "string" &&
    (RATING_VALUES as readonly string[]).includes(value)
  );
}

export interface StoredRating {
  messageId: string;
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
 * Writes the judgement, or replaces the one this person gave before.
 *
 * An upsert rather than an insert, because on the screen the four buttons are
 * one choice: pressing another one is a correction, not a second opinion. Two
 * different people rating the same answer are two rows, which is what the
 * unique constraint is keyed on.
 */
export async function rateAnswer(input: {
  messageId: string;
  rating: RatingValue;
  ratedBy: string;
}): Promise<StoredRating> {
  const result = await pool.query<{
    message_id: string;
    rating: RatingValue;
    rated_by: string;
    updated_at: Date;
  }>(
    `
      INSERT INTO answer_ratings (message_id, rating, rated_by)
      VALUES ($1, $2, $3)
      ON CONFLICT (message_id, rated_by)
      DO UPDATE SET
        rating = EXCLUDED.rating,
        updated_at = NOW()
      RETURNING message_id, rating, rated_by, updated_at
    `,
    [input.messageId, input.rating, input.ratedBy]
  );

  const row = result.rows[0];

  return {
    messageId: row.message_id,
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
    rating: RatingValue;
    rated_by: string;
    updated_at: Date;
  }>(
    `
      SELECT
        answer_ratings.message_id,
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
    rating: row.rating,
    ratedBy: row.rated_by,
    ratedAt: row.updated_at.toISOString()
  }));
}
