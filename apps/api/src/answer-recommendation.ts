/**
 * A VÁSÁRLÁSI JAVASLAT SZABÁLYA AZ ALAP-UTASÍTÁSBAN (kártya 355f7286; a kérdéskészlet 2026-11-20 20:15, `recommendation-refused`, barracuda ítélete: FAIL).
 *
 * A „ne ajánlj konkrét terméket” mondat már ott áll a termékkontextus-ágakban (`no-product-context.ts`, `product-context.ts`), de CSAK a feltétel nélküli választást fogta meg.
 * A FAIL-t kapott válasz nem mondta ki, hogy „vedd az X-et”: leírta a két márkát, megadta a szempontokat, majd a szempontokat a két megnevezett termékre fordította
 * („szűkebb keretnél nagy eséllyel Bubble Magus”, „ha a stabilitás fontosabb: inkább Reef Octopus”), és felajánlotta, hogy megmondja, „melyik a logikusabb választás”.
 * Ez feltételes vásárlási javaslat, és az ajánlat, hogy megmondja, ugyanaz a döntés később.
 *
 * ÁLLANDÓ RÉSZ, FELTÉTEL NÉLKÜL, mint az élő adat és a szójegyzék szabálya (`FIXED_INSTRUCTIONS`): a javaslat tilalma nem a termékkontextus állapotától függ, és egy ágban hagyni
 * (egy üzemzavar csendben elvinné) az volt, ami a mérésen kiütközött.
 *
 * ÉS AMIT NEM ÉRINT: a szempontokról szóló kérdés („milyen szempontok szerint válasszak fehérjelehúzót?”). Arra teljes, érdemi válasz jár: a szabály a DÖNTÉSRŐL szól, nem a tanácsról.
 * Ezt a kérdéskészlet `recommendation-criteria-given` kérdése méri, mert egy szabály, ami ezt is elutasítja, rosszabb a semminél.
 *
 * A SZÖVEG HATÁSA A MODELLEN MÉRHETŐ, NEM A KÓDBÓL: a helyi tesztek azt mondják ki, hogy a szabály minden ágban ott van és mit tilt/enged; hogy a modell be is tartja-e, azt a
 * kérdéskészlet futása és az ember-ítélet mondja meg.
 */
export const RECOMMENDATION_INSTRUCTIONS = [
  "VÁSÁRLÁSI JAVASLAT. Nem döntesz a vevő helyett, semmilyen formában. Ha két (vagy",
  "több) terméket vagy márkát hasonlítanak össze, és a vevő azt kérdezi, melyiket",
  "vegye meg:",
  "- Leírhatod mindegyiket általánosságban: mi az, miről ismert, miben erős, miben",
  "  gyengébb.",
  "- Elmondhatod, milyen szempontok döntenek (térfogat, terhelés, zajszint, ár), és",
  "  hogy egy-egy szempont általában merre billenti a döntést.",
  "- A döntést NEM mondod ki. Nem írsz olyat, hogy »ha kicsi a medence, ezt vedd, ha",
  "  sok hal lesz benne, azt«, »nagy eséllyel az X«, »inkább az Y«, »az X a",
  "  biztosabb választás«, a kérdésben szereplő termékek nevével. Egy mondat, amely",
  "  egy megnevezett terméket mutat meg vásárlásra, javaslat, akármilyen óvatosan,",
  "  feltételesen vagy visszafogottan mondod.",
  "- Azt sem ajánlod fel, hogy te mondod meg a választ (»írd meg a literszámot, és",
  "  megmondom, melyik való«). Ajánlhatod, hogy a megadott adatok alapján végigmész a",
  "  szempontokon, vagy elmondod, mit állít a gyártó adatlapja a két típusról, és",
  "  hogy a döntés a vevőé.",
  "",
  "Ha a kérdés csak a szempontokról szól (»mi alapján válasszak fehérjelehúzót?«),",
  "teljes, érdemi választ adsz: ez a szabály a döntésről szól, nem a tanácsról."
].join("\n");
