import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatInstructions } from "./app.js";
import { SPECIES_NAME_INSTRUCTIONS } from "./answer-species-name.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  SEARCH_UNAVAILABLE_INSTRUCTIONS
} from "./product-context.js";

/**
 * A KEMÉNY KORALL FAJNEVÉNEK SZABÁLYA A PROMPTBAN (kártya 2aa6c8fb). MI PIROSÍT: a szabály egy termékkontextus-állapotban vagy egy vevő-módban kimarad; a szöveg a tilalmat
 * (a faj kizárólagos jellemzői) vagy a helyettesítő mondatot (a nemzetség szintje, a besorolás természete) elhagyja; vagy a hatókör kimondott kivételei (hal és gerinctelen, a
 * nemzetségről szóló kérdés, a vevő saját adata, az ellenőrzött `knowledge`-tény) elesnek, vagyis a szabály túlalkalmaz. A modell viselkedését a kérdéskészlet futása méri, nem ez a teszt.
 */
describe("a kemény korall fajnevének szabálya a promptban", () => {
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
          chatInstructions(resolution, productContext).includes(SPECIES_NAME_INSTRUCTIONS),
          `${resolution.mode}: a fajnév szabálya kimaradt`
        );
  });

  // a sortörések szóközzé hajtva: a szabály sorokra tördelt, a mondatai nem
  const flat = SPECIES_NAME_INSTRUCTIONS.replace(/\s+/g, " ");

  it("a faj kizárólagos jellemzőit tiltja: tartási szám, növekedés, társíthatóság", () => {
    assert.match(flat, /a névben álló faj KIZÁRÓLAGOS jellemzőire nem építesz/);
    assert.match(flat, /konkrét PAR-tartomány, konkrét áramlásigény, számmal/);
    assert.match(flat, /növekedési forma, végleges méret, a szín stabilitása/);
    assert.match(flat, /két faj közötti társíthatósági vagy versengési állításra/);
  });

  it("a nemzetség szintjén enged, és kimondatja a besorolás természetét", () => {
    assert.match(flat, /a NEMZETSÉG szintjén mondj biztosat/);
    assert.match(flat, /nem genetikai vizsgálattal megerősített azonosítás/);
    assert.match(flat, /a nemzetség általános követelményei szerint tervezni/);
  });

  it("a hatókör kivételei kimondva: hal és gerinctelen, a nemzetségről szóló kérdés, a vevő saját adata, az ellenőrzött tény", () => {
    assert.match(flat, /Ez NEM vonatkozik: a halakra és a legtöbb gerinctelenre/);
    assert.match(flat, /nem teszed hozzá a besorolás mondatát/);
    assert.match(flat, /a nemzetségről vagy a keménykorallok általános tartásáról szóló kérdésre/);
    assert.match(flat, /arra, amit a vevő a saját akváriumáról ír/);
    assert.match(flat, /`knowledge` listában forrással ad/);
    assert.match(flat, /A szabály a SAJÁT találgatásodról szól, nem a megadott tényről/);
  });
});
