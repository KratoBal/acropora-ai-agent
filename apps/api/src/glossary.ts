/**
 * A magyar akvarisztikai szójegyzék, ahogy a modell beszéljen.
 *
 * HOL ÁLL, ÉS MIÉRT NEM A TERMÉKKONTEXTUSBAN. Ez NYELVI szabály, nem az, hogy
 * mit lát: akkor is érvényes, ha nincs katalógus, és akkor is, ha a vevő anonim.
 * Ha a termékkontextus ága alatt állna, egy ÜZEMZAVAR csendben elvinné a nyelvi
 * szabályt is -- a modell egyszerre veszítené el a termékadatot és a
 * szóhasználatot, holott a kettőnek semmi köze egymáshoz.
 *
 * ÉS AMIT EZ A SZÖVEG MÉR, AZT ELŐRE LEMÉRTÜK. Alapvonal 2026-08-28, 18 válasz:
 * előírt alak 11, kerülendő 26 -- ebből 18 a lehabzó körül -- és JAVÍTANDÓ HIBA
 * NULLA. A harmadik szám a fontos: ma egyetlen hibás fordítás sincs, és annak
 * nullának is kell maradnia. Egy nyelvi szabály, ami hibát szül, nettó
 * veszteség, akármennyit javít a szóhasználaton.
 */

/**
 * A két rész SZÁNDÉKOSAN külön mondat, és ez a lap legfontosabb része.
 *
 * A mérés szerint a modell hatból négyszer a `fehérjehabozó (protein skimmer)`
 * párost használja: nem téveszt, hanem egy megszokott alakot ír, amiben az
 * angol szó zárójelben ül. Egy szabály, ami CSAK az előírt alakot nevezi meg,
 * ezt nem szünteti meg -- a válasz simán lehet `lehabzó (protein skimmer)`, és
 * a kerülendő szó ugyanúgy ott marad.
 *
 * Ezért a rövidítés és a köznév KÜLÖN szabályt kap, és a kettő látszólag
 * ellentmond egymásnak: az egyik kéri az angol alakot, a másik tiltja. Nem
 * ellentmondás -- két különböző dologra vonatkoznak, és ha egy szabályba
 * vonnánk össze, az egyik eset mindig sérülne.
 */
/**
 * A RÖVIDÍTÉSEK, ADATKÉNT (kártya 7a5ea203, Balázs 2026-08-27: ATO, ICP, RO, TDS, KH, PAR).
 *
 * A FORRÁSNYELV MEZŐ, NEM FELTEVÉS. A szabály az "eredeti kifejezést" kéri, és a példák többsége angol, de a KH
 * nem: a Karbonathärte német. Ha a lista az angolt feltételezné, a KH egy kitalált angol kifejezést kapna.
 * Ma kód-konstans (a verziója az `instructionsVersion`); a szerkeszthető, tárolt szójegyzék külön szelet.
 */
export interface Abbreviation {
  abbreviation: string;
  original: string;
  language: "en" | "de";
  hungarian: string;
}

export const ABBREVIATIONS: readonly Abbreviation[] = [
  {
    abbreviation: "ATO",
    original: "Automatic Top Off",
    language: "en",
    hungarian: "automatikus párolgás-utántöltő rendszer"
  },
  {
    abbreviation: "ICP",
    original: "Inductively Coupled Plasma",
    language: "en",
    hungarian: "induktív csatolású plazma, ICP-OES vízelemzés"
  },
  {
    abbreviation: "RO",
    original: "Reverse Osmosis",
    language: "en",
    hungarian: "fordított ozmózis"
  },
  {
    abbreviation: "TDS",
    original: "Total Dissolved Solids",
    language: "en",
    hungarian: "összes oldott szilárd anyag"
  },
  {
    abbreviation: "KH",
    original: "Karbonathärte",
    language: "de",
    hungarian: "karbonátkeménység"
  },
  {
    abbreviation: "PAR",
    original: "Photosynthetically Active Radiation",
    language: "en",
    hungarian: "fotoszintetikusan aktív sugárzás"
  }
];

const LANGUAGE_NAMES: Record<Abbreviation["language"], string> = {
  en: "angol",
  de: "német"
};

/** Egy sor az utasításba: `KH (Karbonathärte, német - karbonátkeménység)`. */
export function abbreviationLine(entry: Abbreviation): string {
  return `${entry.abbreviation} (${entry.original}, ${LANGUAGE_NAMES[entry.language]} - ${entry.hungarian})`;
}

export const GLOSSARY_INSTRUCTIONS = [
  "MAGYAR SZAKNYELV. Így nevezzük a dolgokat, és így nevezd te is.",
  "",
  "Ezeket használd: tengeri akvárium, korallos akvárium, tengeri akvarisztika,",
  "lehabzó (a fehérjelehabzó is jó).",
  "",
  "Ezeket ne: zátonyakvárium, sósvízi irányultság, sósvizes akvarisztika,",
  "fehérjehabozó, fehérjehabzó, fehérjelefölöző, skimmer, skimmel.",
  "",
  "KÖZNÉVNÉL AZ ANGOL ALAK ZÁRÓJELBEN SEM KELL. A `lehabzó (protein skimmer)`",
  "ugyanúgy kerülendő, mint a `skimmer` önmagában: ha a magyar megnevezés",
  "érthető, az angol nem tesz hozzá semmit, csak visszahozza azt a szót,",
  "amelyiket épp elkerültük.",
  "",
  "RÖVIDÍTÉSNÉL VISZONT PONT FORDÍTVA: az első előforduláskor bontsd ki",
  "az eredeti kifejezéssel ÉS magyarul, például: ATO (Automatic Top Off -",
  "automatikus párolgás-utántöltő rendszer). Ugyanabban a beszélgetésben",
  "másodszor már ne bontsd ki: az ismételt kibontás bőbeszédűség, nem pontosság.",
  "Az eredeti kifejezés nem mindig angol: a KH német.",
  "",
  "Az ismert rövidítések:",
  ...ABBREVIATIONS.map(abbreviationLine),
  "",
  "Ne találj ki magyar rövidítést ott, ahol a szakma az eredetit használja.",
  "",
  "És ne told bele a szójegyzéket olyan válaszba, ahol nem merül fel. Ha a",
  "kérdés a nitrátszintről szól, a válasz a nitrátszintről szóljon."
].join("\n");
