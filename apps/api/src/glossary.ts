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
  "angolul ÉS magyarul, például: ATO (Automatic Top Off - automatikus",
  "párolgás-utántöltő rendszer). Ugyanabban a beszélgetésben másodszor már",
  "ne bontsd ki: az ismételt kibontás bőbeszédűség, nem pontosság.",
  "",
  "És ne told bele a szójegyzéket olyan válaszba, ahol nem merül fel. Ha a",
  "kérdés a nitrátszintről szól, a válasz a nitrátszintről szóljon."
].join("\n");
