import { GLOSSARY_INSTRUCTIONS, renderGlossaryInstructions } from "./glossary.js";
import { loadActiveGlossary, type GlossaryQuery } from "./glossary-store.js";

/**
 * A SZÓJEGYZÉK, AHOGY A PROMPT OLVASSA (Acropora OS kártya 7a5ea203, B2).
 *
 * A tárolt, verziózott lista (glossary-store.ts) kerül a szövegbe, rövid TTL-es cache-sel, és MINDEN ÚT BIZTONSÁGOSAN a kód-konstansra esik
 * vissza: a nyelvi szabály nem vész el egy üzemzavarban, és a chat nem esik el miatta (a glossary.ts fejléce ezt kéri). A `current()` SOHA nem
 * dob.
 *
 *   tárolt szójegyzék olvasható      a szöveg a tárolt listából, `version` = a verzió száma
 *   üres tábla (még nincs seed)      a kód-konstans, `version: null`
 *   az olvasás hibázik, volt jó érték  az UTOLSÓ JÓ érték (elavult, de a mi szavunk), újrapróbálás rövid várakozás után
 *   az olvasás hibázik, nem volt       a kód-konstans, `version: null`
 *
 * A `version: null` ezért azt mondja: ez a válasz a kód-konstanssal készült, nem egy tárolt verzióval.
 */

export interface GlossaryCurrent {
  /** A tárolt verzió száma, vagy `null`, ha a kód-konstans szolgált. */
  version: number | null;
  /** A szójegyzék utasításszövege, ahogy a modell kapja. */
  text: string;
  source: "stored" | "constants";
}

export interface GlossaryProvider {
  current(): Promise<GlossaryCurrent>;
  /** Eldobja a cache-t: a következő `current()` újraolvas (a szerkesztő írása után, C). */
  invalidate(): void;
}

const CONSTANTS: GlossaryCurrent = { version: null, text: GLOSSARY_INSTRUCTIONS, source: "constants" };

export const DEFAULT_TTL_MS = 60_000;
/** Hibás olvasás után ennyit várunk az újrapróbálásig: ne verjük a hibázó adatbázist minden kéréssel. */
export const RETRY_AFTER_FAILURE_MS = 5_000;

export function createGlossaryProvider(options: {
  /** `null`: nincs adatbázis beállítva (egy teszt, vagy egy kézzel indított példány): a kód-konstans. */
  db: GlossaryQuery | null;
  ttlMs?: number;
  retryMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}): GlossaryProvider {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryMs = options.retryMs ?? RETRY_AFTER_FAILURE_MS;
  const now = options.now ?? Date.now;
  /** Az utolsó SIKERES olvasás, és az, amit épp adunk (hiba után az előbbi, vagy a konstans), meddig érvényes. */
  let lastGood: GlossaryCurrent | null = null;
  let served: GlossaryCurrent | null = null;
  let validUntil = 0;
  let inFlight: Promise<GlossaryCurrent> | null = null;

  async function load(): Promise<GlossaryCurrent> {
    if (!options.db) return CONSTANTS;
    try {
      const active = await loadActiveGlossary(options.db);
      const next: GlossaryCurrent = active
        ? { version: active.version, text: renderGlossaryInstructions(active.entries), source: "stored" }
        : CONSTANTS;
      lastGood = next;
      served = next;
      validUntil = now() + ttlMs;
      return next;
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // a hibajelzés hibája nem lehet nagyobb baj, mint az, amit jelez
      }
      // hiba után az utolsó jó érték (vagy a konstans) szolgál, és a várakozás alatt nem olvasunk újra
      served = lastGood ?? CONSTANTS;
      validUntil = now() + retryMs;
      return served;
    }
  }

  return {
    async current() {
      if (!options.db) return CONSTANTS;
      if (served && now() < validUntil) return served;
      // az első betöltés előtt, vagy lejárat után: EGY olvasás, a párhuzamos hívók osztoznak rajta
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate() {
      validUntil = 0;
    }
  };
}
