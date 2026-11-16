import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatInstructions } from "./app.js";
import { LIVE_DATA_INSTRUCTIONS } from "./live-data.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  SEARCH_UNAVAILABLE_INSTRUCTIONS
} from "./product-context.js";

/**
 * AZ ÉLŐ ADAT SZABÁLYA AZ ALAP-UTASÍTÁSBAN (kártya 7a5ea203). MI PIROSÍT: a szabály egy termékkontextus-állapotban
 * vagy egy vevő-módban kimarad (egy üzemzavar csendben elvinné); a szöveg megengedi, hogy a modell lekérdezettnek
 * mutassa az adatot, vagy hogy megmondja, hol nézze meg (mátrix 17. sor); vagy a felhasználó saját mérését is
 * letiltja.
 */
describe("az élő adat szabálya a promptban", () => {
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
      for (const resolution of resolutions) {
        const instructions = chatInstructions(resolution, productContext);
        assert.ok(
          instructions.includes(LIVE_DATA_INSTRUCTIONS),
          `${resolution.mode}: az élő adat szabálya kimaradt`
        );
      }
  });

  it("kimondja: nincs információja, nem sugallja a lekérdezést, és nem mondja meg, hol nézze meg", () => {
    assert.match(LIVE_DATA_INSTRUCTIONS, /nincs információd/);
    assert.match(LIVE_DATA_INSTRUCTIONS, /ne sugalld, hogy lekérdezted/);
    assert.match(LIVE_DATA_INSTRUCTIONS, /még típusként se nevezz meg/);
  });

  it("a felhasználó saját mérését nem tiltja", () => {
    assert.match(LIVE_DATA_INSTRUCTIONS, /SAJÁT mérését ez nem érinti/);
  });
});
