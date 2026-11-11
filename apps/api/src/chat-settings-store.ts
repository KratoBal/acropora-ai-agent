import type { ChatSettingsView } from "./chat-settings.js";
import { parseChatSettingsView } from "./chat-settings.js";

/** Just what the store needs of a `pg` client or pool, so a test can hand in a recording one. */
export interface SettingsQuery {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/** One row, replaced on every successful read from the OS. */
export const SAVE_LAST_KNOWN_SQL = `
  INSERT INTO chat_settings_last_known (singleton, message_retention_days, offer_enabled, contact_request_enabled, read_at)
  VALUES (TRUE, $1, $2, $3, NOW())
  ON CONFLICT (singleton) DO UPDATE SET
    message_retention_days = EXCLUDED.message_retention_days,
    offer_enabled = EXCLUDED.offer_enabled,
    contact_request_enabled = EXCLUDED.contact_request_enabled,
    read_at = EXCLUDED.read_at
`;

export const LOAD_LAST_KNOWN_SQL = `
  SELECT message_retention_days, offer_enabled, contact_request_enabled
  FROM chat_settings_last_known
  WHERE singleton
`;

export async function saveLastKnown(
  db: SettingsQuery,
  view: ChatSettingsView
): Promise<void> {
  await db.query(SAVE_LAST_KNOWN_SQL, [
    view.messageRetentionDays,
    view.offerEnabled,
    view.contactRequestEnabled
  ]);
}

/** `null` when nothing was ever read, and also when the stored row is not what the contract allows (it is not repaired). */
export async function loadLastKnown(
  db: SettingsQuery
): Promise<ChatSettingsView | null> {
  const result = await db.query(LOAD_LAST_KNOWN_SQL);
  const row = result.rows[0];
  if (!row) return null;
  return parseChatSettingsView({
    messageRetentionDays: row.message_retention_days,
    offerEnabled: row.offer_enabled,
    contactRequestEnabled: row.contact_request_enabled
  });
}
