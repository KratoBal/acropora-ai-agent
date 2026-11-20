import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatInstructions } from "./app.js";
import { FALSE_PREMISE_INSTRUCTIONS } from "./answer-false-premise.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import { EMPTY_RESULT_INSTRUCTIONS, SEARCH_UNAVAILABLE_INSTRUCTIONS } from "./product-context.js";

/**
 * A NEM LÉTEZŐ TERMÉK SZABÁLYA A PROMPTBAN (kártyák c3f7aa01, 48d8229a, e2a5c8e6). MI PIROSÍT: a szabály egy termékkontextus-állapotban vagy egy vevő-módban kimarad; a szöveg nem az ELSŐ mondatba
 * teszi a kimondást; nem tiltja a kitalált méretet és a létezőként leírást; nem engedi át a hasonló, létező típusra csak a „másik termék” kimondásával; vagy a létező terméket nevező kérdést is
 * érinti. A modell viselkedését a kérdéskészlet futása méri (`false-premise-corrected`, `false-premise-not-invented`), nem ez a teszt.
 */
describe("a nem létező termék szabálya a promptban", () => {
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
          chatInstructions(resolution, productContext).includes(FALSE_PREMISE_INSTRUCTIONS),
          `${resolution.mode}: a nem létező termék szabálya kimaradt`
        );
  });

  it("az ELSŐ mondatban mondatja ki, és addig semmit nem enged leírni, számot sem", () => {
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /Az ELSŐ mondatban kimondod, hogy ilyen típust nem ismersz/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /azonnal megindokolod/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /Addig semmit nem írsz le róla/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /nem adsz neki méretet, térfogatot/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /nem nevezed létező típusnak, kategóriának vagy sorozatnak/);
  });

  it("a hasonló, létező típusra csak a »másik termék« kimondásával, kitalált szám nélkül enged átmenni", () => {
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /Csak ezután térhetsz át egy hasonló, LÉTEZŐ típusra/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /az másik termék/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /Méretet, térfogatot\s+vagy más számot nem találsz ki, akkor sem, ha »nagyjából«, »kb\.«/);
  });

  it("a létező terméket nevező kérdést nem érinti, és a kínálatunkról nem szól", () => {
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /Ha a kérdés létező terméket nevez meg, ez a szabály nem érinti/);
    assert.match(FALSE_PREMISE_INSTRUCTIONS, /Azt nem teszed hozzá, hogy nálunk kapható-e/);
  });
});
