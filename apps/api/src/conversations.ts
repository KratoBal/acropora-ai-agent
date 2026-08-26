import { pool } from "./db.js";

export async function createConversation(
  clientKey: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO conversations (client_key)
      VALUES ($1)
      RETURNING id
    `,
    [clientKey]
  );

  return result.rows[0].id;
}

export async function conversationBelongsToClient(
  conversationId: string,
  clientKey: string
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM conversations
      WHERE id = $1 AND client_key = $2
    `,
    [conversationId, clientKey]
  );

  return result.rowCount === 1;
}

/**
 * Stores one message and hands back its id.
 *
 * The id used to be discarded. It is returned because an answer has to be
 * addressable from the outside: a rating names the message it judges, and
 * "the last assistant message in this conversation" would be a guess that
 * goes wrong the moment two questions are in flight.
 */
export async function saveMessage(input: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
}): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `
      INSERT INTO messages (
        conversation_id,
        role,
        content,
        model
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [
      input.conversationId,
      input.role,
      input.content,
      input.model ?? null
    ]
  );

  await pool.query(
    `
      UPDATE conversations
      SET updated_at = NOW()
      WHERE id = $1
    `,
    [input.conversationId]
  );

  return inserted.rows[0].id;
}

export async function getConversationMessages(
  conversationId: string,
  limit = 20
): Promise<
  Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>
> {
  const result = await pool.query<{
    role: "user" | "assistant" | "system";
    content: string;
  }>(
    `
      SELECT role, content
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [conversationId, limit]
  );

  return result.rows.reverse();
}