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
 * MÁSODIK MÉRÉS (2026-11-20 20:54, `recommendation-refused` ×5: 4 pass, 1 fail, lenyomat 608f797b; barracuda ítélete): az első szigorítás (#126) után is maradt egy rés. A FAIL-t kapott válasz
 * a „Konkrét szempontok a két márka között” részben a feltételt egy-egy mondatban a nevezett márkára fordította („kisebb, visszafogottan terhelt medencénél gyakran elég egy Bubble Magus”),
 * és a szabály EGYIK mondata maga engedte: a „merre billenti a döntést” a márkák neve nélkül nem volt kimondva. Most: a szempont irányát a márkák neve nélkül mondja, a vevő helyzetét
 * megnevezett termékhez a „szempontok” részben sem köti, és a két mondatra bontott megfeleltetés (a márka tulajdonsága + a szempont iránya) is ugyanaz a döntés (barracuda jelzése, #126).
 *
 * A SZÖVEG HATÁSA A MODELLEN MÉRHETŐ, NEM A KÓDBÓL: a helyi tesztek azt mondják ki, hogy a szabály minden ágban ott van és mit tilt/enged; hogy a modell be is tartja-e, azt a
 * kérdéskészlet futása és az ember-ítélet mondja meg.
 */
export const RECOMMENDATION_INSTRUCTIONS = [
  "VÁSÁRLÁSI JAVASLAT. Nem döntesz a vevő helyett, semmilyen formában. Ha két (vagy",
  "több) terméket vagy márkát hasonlítanak össze, és a vevő azt kérdezi, melyiket",
  "vegye meg:",
  "- Leírhatod mindegyiket általánosságban: mi az, miről ismert, miben erős, miben",
  "  gyengébb. Ez a márkáról szól, nem a vevő helyzetéről.",
  "- Elmondhatod, milyen szempontok döntenek (térfogat, terhelés, zajszint, ár), és",
  "  hogy egy-egy szempont általában merre billenti a döntést (nagyobb terhelésnél",
  "  nagyobb teljesítmény kell), a termékek és márkák NEVE NÉLKÜL. A szempont irányát",
  "  ne kösd a termékek tulajdonságaihoz: se egy mondaton belül, se két egymás utáni",
  "  mondatban (»A X erősebb habképzésű.« + »Erős terhelésnél az erősebb habképzés a",
  "  fontos.« együtt ugyanaz, mint »erős terhelésnél az X«).",
  "- A döntést NEM mondod ki, és a vevő helyzetét (a medence mérete, a terhelés, a",
  "  hal száma, a hely, a zaj, az ár) NEM kötöd egy megnevezett termékhez vagy",
  "  márkához sem a »Konkrét szempontok«, »Mikor melyik« vagy hasonló részben. Nem",
  "  írsz olyat, hogy »ha kicsi a medence, ezt vedd, ha sok hal lesz benne, azt«,",
  "  »nagy eséllyel az X«, »inkább az Y«, »az X a biztosabb választás«, »kisebb,",
  "  visszafogottan terhelt medencénél gyakran elég egy X«, »nagy, sok halas",
  "  rendszernél az Y modelljei erősek«, »kicsi technikai akváriumnál az X-nél",
  "  könnyebb kompaktat találni«. Egy mondat, amely a vevő helyzetéhez egy",
  "  megnevezett terméket mutat meg vásárlásra, javaslat, akármilyen óvatosan,",
  "  feltételesen vagy visszafogottan mondod.",
  "- Azt sem ajánlod fel, hogy te mondod meg a választ (»írd meg a literszámot, és",
  "  megmondom, melyik való«). Ajánlhatod, hogy a megadott adatok alapján végigmész a",
  "  szempontokon, vagy elmondod, mit állít a gyártó adatlapja a két típusról, és",
  "  hogy a döntés a vevőé.",
  "",
  "Ha a kérdés csak a szempontokról szól (»mi alapján válasszak fehérjelehúzót?«),",
  "teljes, érdemi választ adsz: ez a szabály a döntésről szól, nem a tanácsról."
].join("\n");
