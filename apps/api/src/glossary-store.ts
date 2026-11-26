import { ABBREVIATIONS, type Abbreviation } from "./glossary.js";

/**
 * A SZÓJEGYZÉK TÁROLT, VERZIÓZOTT ADATKÉNT (Acropora OS kártya 7a5ea203, B rész; acrobot 53661 és 63253).
 *
 * A rövidítések eddig kód-konstansok voltak (`glossary.ts`). Ez a modul a TÁROLÓ: a séma a `db.ts`-ben áll, itt a seed és az olvasás. B1: a tábla,
 * a seed és a renderelés alapja; a prompt, a cache és a /health még a kód-konstanst használja (B2), tehát ez a szelet a viselkedést nem mozdítja.
 *
 * VERZIÓNKÉNT TELJES PILLANATKÉP, CSAK HOZZÁFŰZ. Egy verzió a lista egésze, nem egy sor története: a visszaállítás egy régi verzió másolata, ÚJ
 * verzióként, és egy válasz mellé egyetlen szám (a verzió) elég ahhoz, hogy visszakeressük, milyen lista mellett készült. Az aktív a legnagyobb
 * verzió.
 *
 * AZ `approved` CSAK JELÖL. A négy, jóváhagyásra váró magyar név (ICP, RO, TDS, PAR) a promptban MARAD, ahogy ma (acrobot 63253): hogy kikerüljön-e,
 * Balázs dönti el, amikor a szerkesztőben jóváhagyható. A jelölő nem szűr semmit.
 */

/** Egy sor a tárolt szójegyzékben: az `Abbreviation` mezői plusz a jóváhagyás jelölője. */
export interface GlossaryEntry extends Abbreviation {
  approved: boolean;
}

/** A hat sor, amit az 1. verzió tartalmaz. A négy magyar név, amit Balázs még nem hagyott jóvá, `approved: false`; az ATO és a KH igen. */
const UNAPPROVED = new Set(["ICP", "RO", "TDS", "PAR"]);

export const SEED_ENTRIES: readonly GlossaryEntry[] = ABBREVIATIONS.map((entry) => ({
  ...entry,
  approved: !UNAPPROVED.has(entry.abbreviation)
}));

export const SEED_NOTE = "Az 1. verzió a kód-konstans hat sora (glossary.ts), változtatás nélkül.";

/** Csak amit a tároló egy `pg` kliensből/pool-ból használ, hogy egy teszt rögzítőt adhasson át. */
export interface GlossaryQuery {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/**
 * A SEED EGYETLEN UTASÍTÁS, és ez a lényeg: a verzió-sor és a bejegyzések ugyanabban a CTE-ben jönnek, tehát vagy mind megvan, vagy semmi.
 * Az `INSERT ... WHERE NOT EXISTS` csak akkor ír, ha EGYETLEN verzió sincs; két egyszerre induló példány közül a második az egyedi kulcson
 * `DO NOTHING`-ra fut, nem ad vissza sort, és a bejegyzés-beszúrás neki is üres marad. Egy már szerkesztett (vagy bármilyen) szójegyzék
 * mellé ez soha nem ír.
 */
export const SEED_SQL = `
  WITH new_version AS (
    INSERT INTO glossary_versions (version, created_by, note)
    SELECT 1, 'seed', $1
    WHERE NOT EXISTS (SELECT 1 FROM glossary_versions)
    ON CONFLICT (version) DO NOTHING
    RETURNING version
  )
  INSERT INTO glossary_entries (version, position, abbreviation, original, language, hungarian, approved)
  SELECT new_version.version, e.position, e.abbreviation, e.original, e.language, e.hungarian, e.approved
  FROM new_version,
    unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[])
      AS e(position, abbreviation, original, language, hungarian, approved)
`;

/** A seed futtatása; `true`, ha EZ a hívás írta az 1. verziót, `false`, ha már volt verzió (vagy egy másik példány megelőzött). */
export async function seedGlossary(db: GlossaryQuery, entries: readonly GlossaryEntry[] = SEED_ENTRIES): Promise<boolean> {
  const result = await db.query(SEED_SQL, [
    SEED_NOTE,
    entries.map((_, index) => index + 1),
    entries.map((entry) => entry.abbreviation),
    entries.map((entry) => entry.original),
    entries.map((entry) => entry.language),
    entries.map((entry) => entry.hungarian),
    entries.map((entry) => entry.approved)
  ]);
  return (result.rowCount ?? 0) > 0;
}

export const LOAD_ACTIVE_SQL = `
  SELECT v.version, e.abbreviation, e.original, e.language, e.hungarian, e.approved
  FROM glossary_versions v
  JOIN glossary_entries e ON e.version = v.version
  WHERE v.version = (SELECT MAX(version) FROM glossary_versions)
  ORDER BY e.position
`;

export interface ActiveGlossary {
  version: number;
  entries: GlossaryEntry[];
}

/**
 * Az aktív szójegyzék, vagy `null`, ha nincs (üres tábla), és akkor is, ha egy sor nem az, amit a szerződés enged (nem javítjuk, nem találunk
 * ki hiányzót): a hívó ilyenkor a kód-konstanst használja, a nyelvi szabály nem vész el.
 */
export async function loadActiveGlossary(db: GlossaryQuery): Promise<ActiveGlossary | null> {
  const result = await db.query(LOAD_ACTIVE_SQL);
  if (result.rows.length === 0) return null;
  const entries: GlossaryEntry[] = [];
  let version: number | null = null;
  for (const row of result.rows) {
    const rowVersion = Number(row.version);
    if (!Number.isInteger(rowVersion) || (version !== null && rowVersion !== version)) return null;
    version = rowVersion;
    const { abbreviation, original, language, hungarian, approved } = row;
    if (
      typeof abbreviation !== "string" ||
      typeof original !== "string" ||
      (language !== "en" && language !== "de") ||
      typeof hungarian !== "string" ||
      typeof approved !== "boolean"
    ) {
      return null;
    }
    entries.push({ abbreviation, original, language, hungarian, approved });
  }
  return version === null ? null : { version, entries };
}
