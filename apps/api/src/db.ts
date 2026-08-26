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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    /**
     * What somebody thought of one answer.
     *
     * Ratings hang off the MESSAGE, not off the conversation: a single
     * conversation holds many answers and they are judged one by one, which is
     * the whole point of the internal test surface.
     *
     * The four values are Balazs's, and they are stored with the same keys the
     * surface uses, so nothing has to be translated on the way in or read back
     * through a mapping table later.
     *
     * The unique pair of message and rater is what makes re-rating work. On
     * the screen the four buttons are a choice, not four separate votes:
     * pressing another one changes the answer given, so the write is an upsert
     * against that constraint rather than a second row.
     */
    CREATE TABLE IF NOT EXISTS answer_ratings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      rating TEXT NOT NULL CHECK (
        rating IN ('correct', 'inaccurate', 'dangerous', 'no-data')
      ),
      rated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (message_id, rated_by)
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
