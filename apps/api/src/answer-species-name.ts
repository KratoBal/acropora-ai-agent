/**
 * A KEMÉNY KORALL FAJNEVÉNEK SZABÁLYA AZ ALAP-UTASÍTÁSBAN (kártya 2aa6c8fb; korall 2026-09-09, a termékadat-térkép 5. pontja, „az SPS-név csapdája”;
 * acrobot 2026-11-23, 59419 és 59424).
 *
 * MIÉRT SZABÁLY ÉS NEM ADAT. A faj-szintű név a katalógusban MEGVAN (pl. „Acropora divaricata”), csak nem azt jelenti, aminek látszik: az SPS korallok (elsősorban az
 * Acropora) fajszintű azonosítása a kereskedelemben növekedési forma és szín alapján megy, genetikai vizsgálat nélkül, ez a szakma ismert korlátja, és a mi katalógusunkra is
 * áll. Egy hiányzó adatnál a modell óvatos, mert LÁTJA a hiányt; egy teljesnek tűnő fajnévnél nem az, és a hamis teljesség kikapcsolja ezt az óvatosságot. Ezért ez nem a
 * `knowledge` hiányának esete, és nem is a termékkontextus állapotától függ: ÁLLANDÓ RÉSZ, FELTÉTEL NÉLKÜL, mint a vásárlási javaslat és a nem létező termék szabálya
 * (`FIXED_INSTRUCTIONS`), mert egy kérdés a vevő saját szavából is hozhat fajnevet, termékadat nélkül.
 *
 * MIT TILT, ÉS MIT ENGED. A névben álló faj KIZÁRÓLAGOS jellemzőire (konkrét PAR-tartomány, konkrét áramlásigény, növekedési forma, végleges méret, a szín stabilitása, két faj
 * közötti társíthatóság vagy versengés) nem épít; a nemzetség szintjén mondhat biztosat, és egy mondatban kimondja a besorolás természetét. Ez a konkrét fajpár-társíthatóság
 * hiányából (nincs mező, nincs szabály) a SZÖVEG felét lefedi: az adat hiányát nem pótolja, csak azt tiltja, hogy a modell a névből találja ki.
 *
 * AMIT NEM ÉRINT, KIMONDVA, MERT A TÚLALKALMAZÁS A MÁSIK HIBA. Halak és a legtöbb gerinctelen (rák, csiga, féreg): ott a fajazonosítás megbízható, a faj-szintű válasz teljes
 * érdemi válasz. A nemzetségről vagy a keménykorallok általános tartásáról szóló kérdés. A vevő saját méréséről és saját koralljáról írt adat. És az a faj-specifikus tény, amelyet
 * az OS ellenőrzötten, forrással ad (`knowledge`): az a termék ténye, forrása szerint mondható, a szabály a modell SAJÁT találgatásáról szól.
 *
 * A SZÖVEG HATÁSA A MODELLEN MÉRHETŐ, NEM A KÓDBÓL: a helyi tesztek azt mondják ki, hogy a szabály minden ágban ott van és mit tilt/enged; hogy a modell be is tartja-e, azt a
 * kérdéskészlet futása és az ember-ítélet mondja meg. A kérdéskészlet két kérdése (must-apply a fajnévre, must-not-apply a halra) külön lépés: a kérdéskészlet fájlja a T5.2
 * generátor körében van.
 */
export const SPECIES_NAME_INSTRUCTIONS = [
  "KEMÉNY KORALL FAJNEVE. Az SPS korallok (elsősorban az Acropora), és kisebb mértékben",
  "néhány LPS-csoport (pl. Acan, Micromussa) fajszintű nevét a kereskedelemben növekedési",
  "forma és szín alapján adják, nem genetikai vizsgálattal: egy ilyen név (pl. »Acropora",
  "divaricata«) megnevezés, nem megerősített azonosítás. Ha a kérdés vagy a termékadat",
  "ilyen fajnevet tartalmaz, a névben álló faj KIZÁRÓLAGOS jellemzőire nem építesz:",
  "- faj-specifikus tartási követelményre (konkrét PAR-tartomány, konkrét áramlásigény,",
  "  számmal),",
  "- faj-specifikus növekedési jellemzőre (növekedési forma, végleges méret, a szín",
  "  stabilitása),",
  "- két faj közötti társíthatósági vagy versengési állításra, ha az a névben álló faj",
  "  tulajdonságára hivatkozna.",
  "Helyette a NEMZETSÉG szintjén mondj biztosat (»az Acropora nemzetség általában erős",
  "fényt és áramlást igényel, stabil, érett rendszerben«), és mondd ki egy mondatban, hogy",
  "a pontos faj a kereskedelemben szokásos, látvány alapú besorolás, nem genetikai",
  "vizsgálattal megerősített azonosítás, ezért a tartási igényt biztonságosabb a nemzetség",
  "általános követelményei szerint tervezni, nem a névben álló faj kizárólagos jellemzői",
  "szerint.",
  "Ez NEM vonatkozik: a halakra és a legtöbb gerinctelenre (rák, csiga, féreg), ott a",
  "faj-szintű válasz teljes, érdemi válasz, és nem teszed hozzá a besorolás mondatát; a",
  "nemzetségről vagy a keménykorallok általános tartásáról szóló kérdésre (arra teljes",
  "válasz jár); arra, amit a vevő a saját akváriumáról ír (a saját mérése, a saját",
  "korallja), azzal dolgozol; és arra a faj-specifikus tényre, amelyet az adatblokk a",
  "`knowledge` listában forrással ad: azt a forrás szerint mondhatod. A szabály a SAJÁT",
  "találgatásodról szól, nem a megadott tényről."
].join("\n");
