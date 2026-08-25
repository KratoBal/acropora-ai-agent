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

export async function saveMessage(input: {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO messages (
        conversation_id,
        role,
        content,
        model
      )
      VALUES ($1, $2, $3, $4)
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
}
