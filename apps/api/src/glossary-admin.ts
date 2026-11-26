import {
  GLOSSARY_LIMITS,
  listGlossaryVersions,
  loadGlossaryVersionDetail,
  saveGlossaryVersion,
  type GlossaryEntry,
  type GlossaryQuery,
  type GlossaryTransactionPool,
  type GlossaryVersionDetail,
  type GlossaryVersionInfo
} from "./glossary-store.js";

/**
 * A SZÓJEGYZÉK ÍRÁSA ÉS ELŐZMÉNYE (Acropora OS kártya 7a5ea203, C1). A szerkesztő az OS-ben él (C2, C3); ez az AI szolgáltatás oldala: egy
 * keskeny felület a tárolóra, amit az útvonalak hívnak, és egy teszt kicserélhet.
 */
export interface GlossaryAdmin {
  listVersions(): Promise<GlossaryVersionInfo[]>;
  readVersion(version: number): Promise<GlossaryVersionDetail | null>;
  /** Az új verzió száma; `GlossaryVersionConflict`-ot dob, ha az alapverzió nem az aktív, sima hibát az érvénytelen listára. */
  save(input: { entries: GlossaryEntry[]; createdBy: string; note: string; expectedVersion: number | null }): Promise<number>;
}

export function createDatabaseGlossaryAdmin(pool: GlossaryQuery & GlossaryTransactionPool): GlossaryAdmin {
  return {
    listVersions: () => listGlossaryVersions(pool),
    readVersion: (version) => loadGlossaryVersionDetail(pool, version),
    save: (input) => saveGlossaryVersion(pool, input.entries, input.createdBy, input.note, input.expectedVersion)
  };
}

export interface GlossarySaveRequest {
  expectedVersion: number | null;
  entries: GlossaryEntry[];
  createdBy: string;
  note: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A mentés törzse, szigorúan: az `expectedVersion` KÖTELEZŐ kulcs (szám, vagy `null` = "még nincs tárolt verzió"), mert egy hiányzó alapverzió
 * csendben kikapcsolná az elveszett-frissítés védelmet. A szövegek szélén a szóköz nem jelent semmit, ezért levágjuk; a mezők hossza és
 * a lista érvényessége a tárolóé (`validateGlossaryEntries`). Ismeretlen mezőt nem fogadunk el: az `approvedBy` és az `approvedAt` a szerveré.
 */
export function parseGlossarySave(body: unknown): { ok: true; value: GlossarySaveRequest } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "a törzs egy objektum legyen" };
  const known = new Set(["expectedVersion", "entries", "createdBy", "note"]);
  for (const key of Object.keys(body)) if (!known.has(key)) return { ok: false, message: `ismeretlen mező: ${key}` };
  if (!("expectedVersion" in body)) return { ok: false, message: "az expectedVersion kötelező (szám, vagy null)" };
  const expected = body.expectedVersion;
  if (expected !== null && !(typeof expected === "number" && Number.isInteger(expected) && expected >= 1)) {
    return { ok: false, message: "az expectedVersion pozitív egész vagy null" };
  }
  const createdBy = typeof body.createdBy === "string" ? body.createdBy.trim() : "";
  if (createdBy === "" || createdBy.length > GLOSSARY_LIMITS.createdBy) return { ok: false, message: "a createdBy kötelező szöveg" };
  const noteRaw = body.note ?? "";
  if (typeof noteRaw !== "string") return { ok: false, message: "a note szöveg legyen" };
  const note = noteRaw.trim();
  if (note.length > GLOSSARY_LIMITS.note) return { ok: false, message: `a note legfeljebb ${GLOSSARY_LIMITS.note} karakter` };
  if (!Array.isArray(body.entries)) return { ok: false, message: "az entries lista legyen" };
  const entryKeys = new Set(["abbreviation", "original", "language", "hungarian", "approved"]);
  const entries: GlossaryEntry[] = [];
  for (const [index, raw] of body.entries.entries()) {
    if (!isRecord(raw)) return { ok: false, message: `az entries[${index}] objektum legyen` };
    for (const key of Object.keys(raw)) if (!entryKeys.has(key)) return { ok: false, message: `az entries[${index}] ismeretlen mezője: ${key}` };
    const { abbreviation, original, language, hungarian, approved } = raw;
    if (typeof abbreviation !== "string" || typeof original !== "string" || typeof hungarian !== "string") {
      return { ok: false, message: `az entries[${index}] szöveges mezői szövegek legyenek` };
    }
    if (language !== "en" && language !== "de") return { ok: false, message: `az entries[${index}] nyelve en vagy de` };
    if (typeof approved !== "boolean") return { ok: false, message: `az entries[${index}] approved mezője igaz/hamis` };
    entries.push({ abbreviation: abbreviation.trim(), original: original.trim(), language, hungarian: hungarian.trim(), approved });
  }
  return { ok: true, value: { expectedVersion: expected, entries, createdBy, note } };
}
