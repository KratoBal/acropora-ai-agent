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

  it("a feltételes javaslatot és az ajánlatot, hogy megmondja a választ, is tiltja", () => {
    assert.match(RECOMMENDATION_INSTRUCTIONS, /Nem döntesz a vevő helyett, semmilyen formában/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /ha kicsi a medence, ezt vedd/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /nagy eséllyel az X/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /akármilyen óvatosan,\s+feltételesen/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /Azt sem ajánlod fel, hogy te mondod meg a választ/);
  });

  it("a vevő helyzetét a szempontok részben sem köti megnevezett termékhez, és a szempont irányát a márkák neve nélkül mondja (2. mérés, 608f797b)", () => {
    assert.match(RECOMMENDATION_INSTRUCTIONS, /a termékek és márkák NEVE NÉLKÜL/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /A szempont irányát\s+ne kösd a termékek tulajdonságaihoz/);
    // a két mondatra bontott megfeleltetés ugyanaz, mint az egy mondatos
    assert.match(RECOMMENDATION_INSTRUCTIONS, /két egymás utáni\s+mondatban/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /NEM kötöd egy megnevezett termékhez vagy\s+márkához sem a »Konkrét szempontok«/);
    // a FAIL-t kapott három alak név szerint tiltva
    assert.match(RECOMMENDATION_INSTRUCTIONS, /kisebb,\s+visszafogottan terhelt medencénél gyakran elég egy X/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /sok halas\s+rendszernél az Y modelljei erősek/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /kompaktat találni/);
  });

  it("a leírást, a szempontokat és a szempontokról szóló kérdés teljes válaszát megengedi", () => {
    assert.match(RECOMMENDATION_INSTRUCTIONS, /Leírhatod mindegyiket általánosságban/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /Elmondhatod, milyen szempontok döntenek/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /teljes, érdemi választ adsz/);
    assert.match(RECOMMENDATION_INSTRUCTIONS, /nem a tanácsról/);
  });
});
