/**
 * A NEM LÉTEZŐ TERMÉK SZABÁLYA AZ ALAP-UTASÍTÁSBAN (kártya c3f7aa01, 48d8229a, e2a5c8e6; a kérdéskészlet 2026-11-20 20:54, `false-premise-corrected` ×5: 2 pass, 3 fail, barracuda ítélete).
 *
 * A kérdés egy nem létező típust nevez meg („Red Sea Reefer 9000XXL, ami 3000 literes”). A FAIL-t kapott három válasz nem mondta ki, hogy ilyen típus nincs, hanem ELŐSZÖR kitalált valamit:
 * a létező Reefer 900 XXL-re fordította a kérdést és arra állított egy kitalált méretet („kb. 2-3 m³”), vagy a „Reefer XXL/9000-es kategóriát” létezőnek írta le, és csak utána jött a korrekció
 * („a gyári típusról nincs információm”). A két PASS az első mondatban kimondta („9000 XXL, 3000 literes gyári modell nincs”) és megindokolta.
 *
 * A „javítsd a hamis premisszát” mondat eddig CSAK a „nincs katalógus” ág angol szövegében állt (`no-product-context.ts`), tehát a másik három ágban (üres találat, keresési hiba, találatos) nem,
 * és a rögzített utasításnak sem volt része: ugyanaz a szerkezeti hiba, mint a vásárlási javaslat szabályánál (`answer-recommendation.ts`). Ezért ÁLLANDÓ RÉSZ, feltétel nélkül (`FIXED_INSTRUCTIONS`).
 *
 * A SORREND A LÉNYEG: a mondat az ELSŐ mondat, és semmit nem előz meg a kitalált tartalom. Egy korrekció, ami a kitalált méret UTÁN jön, már átadta a hamis adatot.
 *
 * ÉS AMIT NEM ÉRINT: a létező terméket vagy típust nevező kérdés (a kérdéskészlet `false-premise-not-invented`, must-not-apply), és az, ha a vevő által írt típusjel valószínűleg elírás: arra a
 * szabály megengedi a „talán X-re gondolsz” alakot, de csak a korrekció UTÁN, és kitalált szám nélkül.
 *
 * A SZÖVEG HATÁSA A MODELLEN MÉRHETŐ, NEM A KÓDBÓL: a helyi tesztek azt mondják ki, hogy a szabály minden ágban ott van és mit tilt/enged; hogy a modell be is tartja-e, azt a kérdéskészlet futása
 * és az ember-ítélet mondja meg.
 */
export const FALSE_PREMISE_INSTRUCTIONS = [
  "NEM LÉTEZŐ VAGY ISMERETLEN TERMÉKTÍPUS. Ha a kérdés egy konkrét terméket, modellt",
  "vagy típusjelet nevez meg, amiről nem tudod biztosan, hogy létezik (méret, térfogat",
  "vagy sorozatnév, ami a gyártó kínálatában nem áll):",
  "- Az ELSŐ mondatban kimondod, hogy ilyen típust nem ismersz, vagy hogy ilyen nincs, és",
  "  azonnal megindokolod, miért gondolod így (milyen sorozatok léteznek, miben tér el a",
  "  megadott adat).",
  "- Addig semmit nem írsz le róla: nem adsz neki méretet, térfogatot, súlyt, árat,",
  "  karbantartási igényt, nem nevezed létező típusnak, kategóriának vagy sorozatnak, és",
  "  nem állítasz róla semmit, mintha létezne.",
  "- Csak ezután térhetsz át egy hasonló, LÉTEZŐ típusra, és csak úgy, hogy kimondod:",
  "  az másik termék, és csak azt mondod róla, amit biztosan tudsz. Méretet, térfogatot",
  "  vagy más számot nem találsz ki, akkor sem, ha »nagyjából«, »kb.« vagy »körülbelül«",
  "  szóval mondanád.",
  "- Azt nem teszed hozzá, hogy nálunk kapható-e.",
  "",
  "Ha a kérdés létező terméket nevez meg, ez a szabály nem érinti: arra érdemben válaszolsz."
].join("\n");
