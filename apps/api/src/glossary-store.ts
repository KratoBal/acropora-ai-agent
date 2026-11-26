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
  INSERT INTO glossary_entries (version, position, abbreviation, original, language, hungarian, approved, approved_by, approved_at)
  SELECT new_version.version, e.position, e.abbreviation, e.original, e.language, e.hungarian, e.approved,
    CASE WHEN e.approved THEN 'seed' END, CASE WHEN e.approved THEN NOW() END
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

/** Amit az írás egy `pg` poolból használ: egy kliens, amin a tranzakció fut. A teszt rögzítőt adhat át. */
export interface GlossaryTransactionPool {
  connect(): Promise<GlossaryQuery & { release(): void }>;
}

/**
 * Egy lista érvényessége, MIELŐTT bármi íródna (a séma kényszerei ugyanezt tartják, de egy ellenőrizetlen lista félúton, tranzakció közben
 * bukna el, és a hibaüzenet a sémáé lenne, nem a szerkesztőé). Üres lista nincs: egy üres verzió elvinné a szójegyzéket.
 */
export const GLOSSARY_LIMITS = { entries: 100, abbreviation: 16, original: 120, hungarian: 200, note: 300, createdBy: 128 } as const;

export function validateGlossaryEntries(entries: readonly GlossaryEntry[]): string | null {
  if (entries.length === 0) return "a szójegyzék nem lehet üres";
  if (entries.length > GLOSSARY_LIMITS.entries) return `a szójegyzék legfeljebb ${GLOSSARY_LIMITS.entries} sor lehet`;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry.abbreviation.length > GLOSSARY_LIMITS.abbreviation ||
      entry.original.length > GLOSSARY_LIMITS.original ||
      entry.hungarian.length > GLOSSARY_LIMITS.hungarian
    ) {
      return `a(z) "${entry.abbreviation.slice(0, GLOSSARY_LIMITS.abbreviation)}" sor szövege túl hosszú`;
    }
    if (!entry.abbreviation.trim() || !entry.original.trim() || !entry.hungarian.trim()) {
      return `a(z) "${entry.abbreviation}" sorban üres szöveg van`;
    }
    if (entry.language !== "en" && entry.language !== "de") return `a(z) "${entry.abbreviation}" nyelve nem en és nem de`;
    if (seen.has(entry.abbreviation)) return `a(z) "${entry.abbreviation}" kétszer szerepel`;
    seen.add(entry.abbreviation);
  }
  return null;
}

/** A mentés a megadott alapverzió ellenére nem fut: közben más mentett (nincs elveszett frissítés). */
export class GlossaryVersionConflict extends Error {
  constructor(readonly activeVersion: number | null) {
    super(`the glossary moved: the active version is ${activeVersion ?? "none"}`);
    this.name = "GlossaryVersionConflict";
  }
}

/**
 * ÚJ VERZIÓ, EGY TRANZAKCIÓBAN: a verzió-sor és a bejegyzései együtt íródnak, vagy semmi (barracuda, #146). Egy félbehagyott írás különben egy
 * bejegyzés nélküli legmagasabb verziót hagyna, az olvasás azt üresnek venné, és a szójegyzék eltűnne a promptból. Az új szám a legnagyobb +1,
 * a két egyszerre író sorba áll egy tábla-zárolásnál. Visszaadja az új verzió számát; érvénytelen listára dob, és nem ír.
 *
 * `expectedVersion` (C1): ha meg van adva (szám, vagy `null` = "még nincs tárolt verzió"), és NEM az aktív verzió, a mentés a zárolás alatt
 * `GlossaryVersionConflict`-ot dob, és nem ír: a szerkesztő így nem írhat felül egy közben mentett listát. Megadatlan: nincs ellenőrzés.
 *
 * A JÓVÁHAGYÁS KINEK ÉS MIKOR (acrobot 63288): soronként `approved_by` és `approved_at`, MENTÉSKOR számolva a szerveren. Ha a sor az előző
 * aktív verzióban is jóváhagyott volt, és a magyar neve ugyanaz, az előző jóváhagyás öröklődik; ha most lett jóváhagyott, vagy a jóváhagyott
 * sor magyar neve megváltozott (az új szöveget senki nem hagyta jóvá), az új jóváhagyó a mentő (`createdBy`), az idő a mostani. Nem jóváhagyott
 * sor: nincs jóváhagyó.
 */
export async function saveGlossaryVersion(
  pool: GlossaryTransactionPool,
  entries: readonly GlossaryEntry[],
  createdBy: string,
  note: string,
  expectedVersion?: number | null
): Promise<number> {
  const problem = validateGlossaryEntries(entries);
  if (problem) throw new Error(problem);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE glossary_versions IN SHARE ROW EXCLUSIVE MODE");
    const active = await client.query("SELECT MAX(version) AS version FROM glossary_versions");
    const activeVersion = active.rows[0]?.version === null || active.rows[0]?.version === undefined ? null : Number(active.rows[0].version);
    if (expectedVersion !== undefined && expectedVersion !== activeVersion) throw new GlossaryVersionConflict(activeVersion);
    const version = (activeVersion ?? 0) + 1;
    const previous = new Map<string, { hungarian: string; approvedBy: string | null; approvedAt: Date | null }>();
    if (activeVersion !== null) {
      const rows = await client.query(
        "SELECT abbreviation, hungarian, approved, approved_by, approved_at FROM glossary_entries WHERE version = $1 AND approved",
        [activeVersion]
      );
      for (const row of rows.rows) {
        previous.set(String(row.abbreviation), {
          hungarian: String(row.hungarian),
          approvedBy: typeof row.approved_by === "string" ? row.approved_by : null,
          approvedAt: row.approved_at instanceof Date ? row.approved_at : null
        });
      }
    }
    const inherited = entries.map((entry) => {
      const before = previous.get(entry.abbreviation);
      return entry.approved && before && before.hungarian === entry.hungarian && before.approvedBy !== null ? before : null;
    });
    await client.query("INSERT INTO glossary_versions (version, created_by, note) VALUES ($1, $2, $3)", [version, createdBy, note]);
    await client.query(
      `
        INSERT INTO glossary_entries (version, position, abbreviation, original, language, hungarian, approved, approved_by, approved_at)
        SELECT $1, e.position, e.abbreviation, e.original, e.language, e.hungarian, e.approved,
          CASE WHEN e.approved THEN COALESCE(e.approved_by, $8) END,
          CASE WHEN e.approved THEN COALESCE(e.approved_at, NOW()) END
        FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $9::text[], $10::timestamptz[])
          AS e(position, abbreviation, original, language, hungarian, approved, approved_by, approved_at)
      `,
      [
        version,
        entries.map((_, index) => index + 1),
        entries.map((entry) => entry.abbreviation),
        entries.map((entry) => entry.original),
        entries.map((entry) => entry.language),
        entries.map((entry) => entry.hungarian),
        entries.map((entry) => entry.approved),
        createdBy,
        inherited.map((before) => before?.approvedBy ?? null),
        inherited.map((before) => before?.approvedAt ?? null)
      ]
    );
    await client.query("COMMIT");
    return version;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // a visszagörgetés hibája nem fedheti el az eredeti hibát
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Egy tárolt verzió fejléce a listához: ki mentette, mikor, mi a megjegyzés. */
export interface GlossaryVersionInfo {
  version: number;
  createdAt: string;
  createdBy: string;
  note: string;
  entryCount: number;
  active: boolean;
}

export const LIST_VERSIONS_SQL = `
  SELECT v.version, v.created_at, v.created_by, v.note, COUNT(e.abbreviation)::int AS entry_count,
    v.version = (SELECT MAX(version) FROM glossary_versions) AS active
  FROM glossary_versions v
  LEFT JOIN glossary_entries e ON e.version = v.version
  GROUP BY v.version, v.created_at, v.created_by, v.note
  ORDER BY v.version DESC
  LIMIT 200
`;

export async function listGlossaryVersions(db: GlossaryQuery): Promise<GlossaryVersionInfo[]> {
  const result = await db.query(LIST_VERSIONS_SQL);
  return result.rows.map((row) => ({
    version: Number(row.version),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    note: String(row.note ?? ""),
    entryCount: Number(row.entry_count),
    active: row.active === true
  }));
}

/** Egy sor a szerkesztőnek: az `approved` mellett, ki hagyta jóvá és mikor (a prompt ezt nem olvassa). */
export interface GlossaryEntryDetail extends GlossaryEntry {
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface GlossaryVersionDetail extends Omit<GlossaryVersionInfo, "entryCount"> {
  entries: GlossaryEntryDetail[];
}

export const LOAD_VERSION_DETAIL_SQL = `
  SELECT v.version, v.created_at, v.created_by, v.note,
    v.version = (SELECT MAX(version) FROM glossary_versions) AS active,
    e.abbreviation, e.original, e.language, e.hungarian, e.approved, e.approved_by, e.approved_at
  FROM glossary_versions v
  JOIN glossary_entries e ON e.version = v.version
  WHERE v.version = $1
  ORDER BY e.position
`;

/** Egy verzió a szerkesztőnek, vagy `null`, ha nincs ilyen (vagy egy sor nem az, amit a szerződés enged: nem javítjuk). */
export async function loadGlossaryVersionDetail(db: GlossaryQuery, version: number): Promise<GlossaryVersionDetail | null> {
  const result = await db.query(LOAD_VERSION_DETAIL_SQL, [version]);
  if (result.rows.length === 0) return null;
  const first = result.rows[0]!;
  const entries: GlossaryEntryDetail[] = [];
  for (const row of result.rows) {
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
    entries.push({
      abbreviation,
      original,
      language,
      hungarian,
      approved,
      approvedBy: typeof row.approved_by === "string" ? row.approved_by : null,
      approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : null
    });
  }
  return {
    version: Number(first.version),
    createdAt: first.created_at instanceof Date ? first.created_at.toISOString() : String(first.created_at),
    createdBy: String(first.created_by),
    note: String(first.note ?? ""),
    active: first.active === true,
    entries
  };
}
