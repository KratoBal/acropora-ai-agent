import type { StoredLinkSource } from "./answer-link-guard.js";

/**
 * THE STORED LINK SOURCES, READ FROM THE ACROPORA OS (card 9d060f5c; plan v3 section 6.3, acrobot 46815). The answer
 * link gate lets an external host out only if it is on this list AND one of the three exceptions holds there; the
 * OS keeps the list next to its AI chat settings, and this service reads it on the settings reader endpoint, behind
 * its OWN token (the OS accepts exactly one service-token record there, `ACROPORA_AI_CHAT_SETTINGS_TOKEN_ID`).
 *
 * EVERY FAILURE READS AS AN EMPTY LIST, and that direction is the point: the list only WIDENS what may leave, so a
 * list that could not be read turns the exceptions off and the gate stays at its default. An outage never lets a
 * link out. The failure is reported to the caller (for the log), never thrown.
 *
 * The entries are checked one by one: a row that is not a host with a known category (and a brand for a
 * manufacturer document) is dropped, never guessed into one.
 */

export const LINK_SOURCES_PATH = "/integrations/ai-chat-settings/service";

/** The token for THIS door: one leaked credential must not carry another system (the product search has its own). */
export const LINK_SOURCES_TOKEN_ENV = "ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN";

/** A settings read, not a search: a short wait, as the answer is already in hand when it is needed. */
export const LINK_SOURCES_TIMEOUT_MS = 3_000;

/** The list changes by hand, rarely: one read a minute is enough, and a chat turn does not wait for the OS each time. */
export const LINK_SOURCES_CACHE_MS = 60_000;

export type LinkSourcesRead =
  | { ok: true; sources: StoredLinkSource[]; dropped: number }
  | { ok: false; sources: []; reason: "not_configured" | "unauthorized" | "unavailable" | "bad_response" };

export interface LinkSourcesOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: number;
}

const CATEGORIES = new Set(["MANUFACTURER_DOCUMENT", "AUTHORITY"]);
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** One entry of the reader's `linkSources`, or null when it is not one the gate can use. */
export function parseLinkSource(raw: unknown): StoredLinkSource | null {
  const entry = raw as { host?: unknown; category?: unknown; brand?: unknown };
  if (typeof entry?.host !== "string" || !HOST.test(entry.host)) return null;
  if (typeof entry.category !== "string" || !CATEGORIES.has(entry.category)) return null;
  const brand = typeof entry.brand === "string" && entry.brand.trim() !== "" ? entry.brand.trim() : null;
  if (entry.category === "MANUFACTURER_DOCUMENT" && brand === null) return null;
  return {
    host: entry.host,
    category: entry.category as StoredLinkSource["category"],
    brand: entry.category === "AUTHORITY" ? null : brand
  };
}

let cache: { at: number; read: LinkSourcesRead & { ok: true } } | null = null;

/** For the specs: the next read goes to the OS. */
export function clearLinkSourcesCache(): void {
  cache = null;
}

/** The stored list, from the OS or the last good read of the past minute. A failed read is not cached. */
export async function readLinkSources(options: LinkSourcesOptions = {}): Promise<LinkSourcesRead> {
  const now = options.now ?? Date.now();
  if (cache && now - cache.at < LINK_SOURCES_CACHE_MS) return cache.read;

  const environment = options.environment ?? process.env;
  const baseUrl = environment.ACROPORA_OS_BASE_URL?.trim().replace(/\/+$/, "");
  const token = environment[LINK_SOURCES_TOKEN_ENV]?.trim();
  if (!baseUrl || !token) return { ok: false, sources: [], reason: "not_configured" };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${baseUrl}${LINK_SOURCES_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? LINK_SOURCES_TIMEOUT_MS)
    });
  } catch {
    // only that it failed travels: a transport error can carry the request, and the request holds the token
    return { ok: false, sources: [], reason: "unavailable" };
  }
  if (response.status === 401 || response.status === 403)
    return { ok: false, sources: [], reason: "unauthorized" };
  if (!response.ok) return { ok: false, sources: [], reason: "unavailable" };

  const body = (await response.json().catch(() => null)) as { linkSources?: unknown } | null;
  // an OS before the list existed answers without the field: that is an empty list, not a broken answer
  if (!body || typeof body !== "object") return { ok: false, sources: [], reason: "bad_response" };
  if (body.linkSources !== undefined && !Array.isArray(body.linkSources))
    return { ok: false, sources: [], reason: "bad_response" };

  const raw = (body.linkSources ?? []) as unknown[];
  const sources = raw.map(parseLinkSource).filter((s): s is StoredLinkSource => s !== null);
  const read = { ok: true as const, sources, dropped: raw.length - sources.length };
  cache = { at: now, read };
  return read;
}
