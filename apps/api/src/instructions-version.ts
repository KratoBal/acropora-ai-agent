import { createHash } from "node:crypto";

/**
 * AZ UTASÍTÁS VERZIÓJA A VÁLASZ MELLETT (Acropora OS kártya 7a5ea203, acrobot 53661).
 *
 * A nyelvi szabályok (alap-utasítás, élő adat, szójegyzék) kód-konstansok, tehát a verziójuk a commit. Ez a
 * futó szolgáltatásról mond valamit, a TÁROLT válaszról nem: egy frissítés után semmi nem mondaná meg, melyik
 * válasz melyik szöveggel készült, és a kérdéskészlet előtte-utána összevetése nem lenne elvégezhető.
 *
 * CSAK AZ ÁLLANDÓ RÉSZBŐL. A teljes utasítás kérésenként változik (termékkontextus, vevő-blokk, link-szabály),
 * és annak a hash-e minden válasznál más lenne: semmit nem csoportosítana. A verzió azt jelöli, ami a nyelvi
 * mérés tárgya. 12 hexa karakter: ennyi elég, hogy két szöveg ne essen egybe, és a táblában olvasható.
 */
export function instructionsVersion(parts: readonly string[]): string {
  return createHash("sha256")
    .update(parts.join("\n\n"))
    .digest("hex")
    .slice(0, 12);
}
