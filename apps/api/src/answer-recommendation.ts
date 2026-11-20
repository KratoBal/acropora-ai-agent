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
 * HARMADIK MÉRÉS (2026-11-20 21:24, `recommendation-refused` ×5: 2 pass, 3 fail; barracuda ítélete; acrobot 58930). A két szöveges szűkítés (#126, #128) után a gyakoriság nem javult (4/1, majd 2/3):
 * a megfeleltetés átköltözött egy záró „Hogyan döntsd el / mérlegelj” részbe, közvélemény-alakban („szűkebb keretnél sokan az X-et választják”, „az Y sokaknál bevált”), és a márkaleírásba
 * („kezdőknek sokszor inkább előny”). Egy újabb példa-lista a modellnek újabb alakot hagy: a példák nem zárják a családot.
 *
 * EZÉRT A SZABÁLY SZERKEZETET ADOTT, NEM CSAK TILTÁST (acrobot: „te döntsd el, melyik a tisztább”): a válasz KÉT KÜLÖN RÉSZ. Az 1. a márkák leírása, ami tény a TERMÉKRŐL (tulajdonság, gyártói állítás),
 * és a vevőre, helyzetre, vevői körre vagy közvéleményre vonatkozó szó nincs benne; a 2. a szempontok, márkanév nélkül, és a záró döntési rész kérdés a vevőhöz, nem megfeleltetés. A kettő
 * között NINCS híd, tehát egyik részben sincs, amit a másikra rá lehetne olvasni úgy, hogy a vevő helyzetéhez márka álljon. A másik utat (a márkaleírás elhagyása elutasításnál, csak szempontok)
 * elvetettem: a kérdés két megnevezett márkáról szól, és egy válasz, amely róluk semmit nem mond, használhatatlan; ráadásul a „csak szempontok” alak a `recommendation-criteria-given` kérdésen
 * (must-not-apply) a túlalkalmazás felé tolná a modellt. A márkaleírás tényei viszont a vevői kör szavai nélkül is hasznosak.
 *
 * A SZÖVEG HATÁSA A MODELLEN MÉRHETŐ, NEM A KÓDBÓL: a helyi tesztek azt mondják ki, hogy a szabály minden ágban ott van és mit tilt/enged; hogy a modell be is tartja-e, azt a
 * kérdéskészlet futása és az ember-ítélet mondja meg.
 */
export const RECOMMENDATION_INSTRUCTIONS = [
  "VÁSÁRLÁSI JAVASLAT. Nem döntesz a vevő helyett, semmilyen formában. Ha két (vagy",
  "több) terméket vagy márkát hasonlítanak össze, és a vevő azt kérdezi, melyiket",
  "vegye meg, a válasz KÉT KÜLÖN részből áll, és a kettőt nem kötöd össze:",
  "",
  "1. A MÁRKÁK LEÍRÁSA: mi az, miről ismert, mit állít a gyártó, milyen típusai",
  "   vannak, miben erős, miben gyengébb. Ez TÉNY A TERMÉKRŐL, nem a vevőről: nem áll",
  "   benne, kinek vagy milyen helyzetre jó (kezdő, kisebb keret, kevesebb hal,",
  "   szűkebb költségkeret), és nincs benne közvélemény vagy minősítés (»sokan",
  "   választják«, »sokaknál bevált«, »népszerű«, »ajánlott«, »előny«, »gyakran elég«).",
  "   Egy tulajdonságot leírhatsz (halkabb, kompaktabb, erősebb szivattyú); hogy ez",
  "   kinek jó, az már javaslat.",
  "",
  "2. A DÖNTÉS SZEMPONTJAI, a termékek és márkák NEVE NÉLKÜL: térfogat, terhelés,",
  "   zajszint, hely, ár, és hogy egy-egy szempont általában merre billenti a döntést",
  "   (nagyobb terhelésnél nagyobb teljesítmény kell). A záró »hogyan döntsd el«,",
  "   »hogyan mérlegelj« rész KÉRDÉSEK a vevőhöz (»mekkora a medence, mennyi hal lesz",
  "   benne, mennyire zavar a zaj?«), nem megfeleltetés: itt egyetlen márka sem",
  "   szerepel. A szempont irányát ne kösd a termékek tulajdonságaihoz: se egy",
  "   mondaton belül, se két egymás utáni mondatban (»A X erősebb habképzésű.« +",
  "   »Erős terhelésnél az erősebb habképzés a fontos.« együtt ugyanaz, mint »erős",
  "   terhelésnél az X«).",
  "",
  "A döntést NEM mondod ki, és a vevő helyzetét (a medence mérete, a terhelés, a hal",
  "száma, a hely, a zaj, az ár, a tapasztalat, a költségkeret) NEM kötöd egy",
  "megnevezett termékhez vagy márkához sehol a válaszban. Nem írsz olyat, hogy »ha",
  "kicsi a medence, ezt vedd, ha sok hal lesz benne, azt«, »nagy eséllyel az X«,",
  "»inkább az Y«, »az X a biztosabb választás«, »kisebb, visszafogottan terhelt",
  "medencénél gyakran elég egy X«, »nagy, sok halas rendszernél az Y modelljei",
  "erősek«, »kicsi technikai akváriumnál az X-nél könnyebb kompaktat találni«,",
  "»szűkebb keretnél sokan az X-et választják«, »az Y sokaknál bevált«, »kezdőknek",
  "az X halkabb működése sokszor előny«. Egy mondat, amely a vevő helyzetéhez vagy",
  "egy vevői körhöz egy megnevezett terméket mutat meg vásárlásra, javaslat,",
  "akármilyen óvatosan, feltételesen, visszafogottan vagy mások tapasztalatára",
  "hivatkozva mondod.",
  "",
  "Azt sem ajánlod fel, hogy te mondod meg a választ (»írd meg a literszámot, és",
  "megmondom, melyik való«). Ajánlhatod, hogy a megadott adatok alapján végigmész a",
  "szempontokon, vagy elmondod, mit állít a gyártó adatlapja a két típusról, és",
  "hogy a döntés a vevőé.",
  "",
  "Ha a kérdés csak a szempontokról szól (»mi alapján válasszak fehérjelehúzót?«),",
  "teljes, érdemi választ adsz: ez a szabály a döntésről szól, nem a tanácsról."
].join("\n");
