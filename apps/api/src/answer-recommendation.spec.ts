import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatInstructions } from "./app.js";
import { RECOMMENDATION_INSTRUCTIONS } from "./answer-recommendation.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  SEARCH_UNAVAILABLE_INSTRUCTIONS
} from "./product-context.js";

/**
 * A VÁSÁRLÁSI JAVASLAT SZABÁLYA A PROMPTBAN (kártya 355f7286). MI PIROSÍT: a szabály egy termékkontextus-állapotban vagy egy vevő-módban kimarad; a szöveg csak a feltétel nélküli választást tiltja
 * (a feltételes, a megnevezett termékekre fordított szempont és az ajánlat, hogy megmondja a választ, kimarad); vagy a szempontokról szóló kérdést is elutasítja. A modell viselkedését a
 * kérdéskészlet futása méri, nem ez a teszt.
 */
describe("a vásárlási javaslat szabálya a promptban", () => {
  it("minden termékkontextus-állapotban és mindkét vevő-módban ott van", () => {
    const states = [
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      EMPTY_RESULT_INSTRUCTIONS,
      SEARCH_UNAVAILABLE_INSTRUCTIONS,
      "<<<TERMEKADAT>>>\n[]\n<<<TERMEKADAT VEGE>>>"
    ];
    const resolutions: Parameters<typeof chatInstructions>[0][] = [
      { ok: true, mode: "anonymous" },
      {
        ok: true,
        mode: "customer",
        context: {
          subjectType: "customer",
          customerId: "cus_1",
          customerNumber: "V-00123",
          entitlements: {},
          entitlementsStatus: "not-modelled",
          entitlementsNote: "..."
        }
      }
    ];
    for (const productContext of states)
      for (const resolution of resolutions)
        assert.ok(
          chatInstructions(resolution, productContext).includes(RECOMMENDATION_INSTRUCTIONS),
          `${resolution.mode}: a vásárlási javaslat szabálya kimaradt`
        );
  });

  // a sortörések szóközzé hajtva: a szabály sorokra tördelt, a mondatai nem
  const flat = RECOMMENDATION_INSTRUCTIONS.replace(/\s+/g, " ");

  it("a feltételes javaslatot és az ajánlatot, hogy megmondja a választ, is tiltja", () => {
    assert.match(flat, /Nem döntesz a vevő helyett, semmilyen formában/);
    assert.match(flat, /ha kicsi a medence, ezt vedd/);
    assert.match(flat, /nagy eséllyel az X/);
    assert.match(flat, /akármilyen óvatosan, feltételesen, visszafogottan vagy mások tapasztalatára hivatkozva/);
    assert.match(flat, /Azt sem ajánlod fel, hogy te mondod meg a választ/);
  });

  it("a vevő helyzetét sehol nem köti megnevezett termékhez, és a szempont irányát a márkák neve nélkül mondja (2. mérés, 608f797b)", () => {
    assert.match(flat, /a termékek és márkák NEVE NÉLKÜL/);
    assert.match(flat, /A szempont irányát ne kösd a termékek tulajdonságaihoz/);
    // a két mondatra bontott megfeleltetés ugyanaz, mint az egy mondatos
    assert.match(flat, /két egymás utáni mondatban/);
    assert.match(flat, /NEM kötöd egy megnevezett termékhez vagy márkához sehol a válaszban/);
    // a 2. mérés FAIL-t kapott három alakja név szerint tiltva
    assert.match(flat, /kisebb, visszafogottan terhelt medencénél gyakran elég egy X/);
    assert.match(flat, /sok halas rendszernél az Y modelljei erősek/);
    assert.match(flat, /kompaktat találni/);
  });

  it("a válasz két külön részből áll: a márkaleírás tény a termékről, a szempontok márkanév nélkül, és a záró döntési rész kérdés (3. mérés)", () => {
    assert.match(flat, /KÉT KÜLÖN részből áll, és a kettőt nem kötöd össze/);
    assert.match(flat, /1\. A MÁRKÁK LEÍRÁSA/);
    assert.match(flat, /TÉNY A TERMÉKRŐL, nem a vevőről/);
    assert.match(flat, /2\. A DÖNTÉS SZEMPONTJAI, a termékek és márkák NEVE NÉLKÜL/);
    // a záró rész kérdés a vevőhöz, márka nélkül
    assert.match(flat, /»hogyan döntsd el«, »hogyan mérlegelj« rész KÉRDÉSEK a vevőhöz/);
    assert.match(flat, /itt egyetlen márka sem szerepel/);
  });

  it("a gyártó műszaki adatát megengedi, a gyártó célcsoport-, terhelés- és elterjedtség-besorolását nem (4. mérés, 65e0242f)", () => {
    assert.match(flat, /a gyártó MŰSZAKI ADATAI \(literadat, méret, teljesítmény, működési elv, zajszint/);
    assert.match(flat, /A GYÁRTÓ CÉLCSOPORT-ÁLLÍTÁSA, a TERHELÉS-BESOROLÁS és az ELTERJEDTSÉG ugyanaz a helyzet-termék megfeleltetés/);
    assert.match(flat, /csak a gyártó vagy a piac szájába adva/);
    // a FAIL-t és a rést adó alakok név szerint tiltva
    assert.match(flat, /inkább közepes terhelésre hangolták/);
    assert.match(flat, /erősebb terhelésre/);
    assert.match(flat, /kezdőknek tervezve/);
    assert.match(flat, /a hobbi kategóriában elterjedt/);
    // a szám, a méret, a literadat, a teljesítmény leírható, de nem mondja meg, milyen vevőnek való
    assert.match(flat, /A számot, a méretet, a literadatot, a teljesítményt leírhatod/);
    assert.match(flat, /milyen terhelésű, tapasztalatú vagy méretű vevőnek való, nem/);
  });

  it("a közvélemény- és minősítés-alakot, a vevői kört és a kezdő-előnyt is tiltja (3. mérés: sokan választják, sokaknál bevált, kezdőknek előny)", () => {
    assert.match(flat, /nincs benne közvélemény vagy minősítés \(»sokan választják«, »sokaknál bevált«, »népszerű«, »ajánlott«, »előny«/);
    assert.match(flat, /szűkebb keretnél sokan az X-et választják/);
    assert.match(flat, /az Y sokaknál bevált/);
    assert.match(flat, /kezdőknek az X halkabb működése sokszor előny/);
    assert.match(flat, /vevői körhöz egy megnevezett terméket mutat meg vásárlásra, javaslat/);
    // a tapasztalat és a költségkeret is a vevő helyzete
    assert.match(flat, /a tapasztalat, a költségkeret\) NEM kötöd/);
  });

  it("a leírást, a szempontokat és a szempontokról szóló kérdés teljes válaszát megengedi", () => {
    assert.match(flat, /mi az, miről ismert, milyen típusai vannak, miben erős, miben gyengébb, és a gyártó MŰSZAKI ADATAI/);
    assert.match(flat, /térfogat, terhelés, zajszint, hely, ár/);
    assert.match(flat, /teljes, érdemi választ adsz/);
    assert.match(flat, /nem a tanácsról/);
  });
});
