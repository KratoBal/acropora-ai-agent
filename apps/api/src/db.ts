import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/**
 * The schema, as a value rather than only as a side effect.
 *
 * Exported so a test can read it without a database. The rating values live
 * in two places by necessity - a CHECK constraint here and a TypeScript union
 * in evaluations.ts - and a value added to one and not the other fails in
 * production, at the moment somebody presses a button, with a constraint
 * violation nobody expected. A test that compares the two costs nothing.
 */
export const SCHEMA_SQL = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model TEXT,
      /*
       * What the model call cost, in tokens. NULL where we do not know.
       *
       * Three columns rather than one, because the two halves are priced
       * differently and a single total cannot be taken apart afterwards.
       *
       * NULL is a real value here and not a gap to be filled with zero: a
       * user message never had a call, an answer written before this column
       * existed cannot be recovered, and a provider response that carried no
       * usage told us nothing. Zero would say the call was free, which is a
       * different claim.
       */
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /*
     * And the same three for a database that already exists.
     *
     * The CREATE TABLE above only runs on an empty database; every deployed
     * instance already has this table, so without these the columns would
     * appear on a developer's fresh database and nowhere else.
     */
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS total_tokens INTEGER;

    /**
     * What somebody thought of one answer.
     *
     * Ratings hang off the MESSAGE, not off the conversation: a single
     * conversation holds many answers and they are judged one by one, which is
     * the whole point of the internal test surface.
     *
     * TWO axes, not one list. A judgement about the facts and a judgement
     * about the wording are different questions, and an answer can be right
     * and unreadable, or fluent and wrong. Each axis carries its own values,
     * stored with the same keys the surface uses, so nothing has to be
     * translated on the way in or read back through a mapping table later.
     *
     * One person may judge the same answer on both axes, and may judge only
     * one of them: nothing here requires a pair.
     *
     * The unique triple of message, rater and axis is what makes re-rating
     * work. Within one axis the buttons are a choice, not separate votes:
     * pressing another one changes the answer given, so the write is an
     * upsert against that constraint rather than a second row. Across axes,
     * and across people, the rows stay separate.
     */
    CREATE TABLE IF NOT EXISTS answer_ratings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      axis TEXT NOT NULL CHECK (axis IN ('accuracy', 'language')),
      rating TEXT NOT NULL,
      rated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (message_id, rated_by, axis),
      /*
       * The value has to be legal ON ITS OWN AXIS.
       *
       * Written as one constraint over both columns rather than a list of
       * eight allowed values, because the two sets are not interchangeable:
       * 'natural' is a judgement about wording and must never land in an
       * accuracy row, not even through a malformed call. A flat list would
       * accept it, and the two vocabularies would quietly merge - which is
       * the exact thing splitting them was meant to prevent.
       */
      CONSTRAINT answer_ratings_value_matches_axis CHECK (
        (
          axis = 'accuracy'
          AND rating IN ('correct', 'inaccurate', 'dangerous', 'no-data')
        )
        OR (
          axis = 'language'
          AND rating IN ('natural', 'wordy', 'foreign', 'confusing')
        )
      )
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_client_key
      ON conversations(client_key);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages(conversation_id);

    CREATE INDEX IF NOT EXISTS idx_answer_ratings_message_id
      ON answer_ratings(message_id);
`;

export async function initializeDatabase(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}
