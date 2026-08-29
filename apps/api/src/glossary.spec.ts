import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatInstructions } from "./app.js";
import { GLOSSARY_INSTRUCTIONS } from "./glossary.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  SEARCH_UNAVAILABLE_INSTRUCTIONS
} from "./product-context.js";

describe("a szójegyzék a promptban", () => {
  /**
   * A LEGFONTOSABB TESZT, és nem a szövegről szól.
   *
   * A szójegyzék nyelvi szabály: akkor is érvényes, ha nincs katalógus. Ha
   * valaha a termékkontextus ága alá kerülne, egy ÜZEMZAVAR csendben elvinné a
   * szóhasználatot is - a modell egyszerre veszítené el a termékadatot és a
   * magyar szaknyelvet, holott a kettőnek semmi köze egymáshoz.
   */
  it("mind a négy termékkontextus-állapotban ott van", () => {
    const states = [
      ["nincs katalógus", NO_PRODUCT_CONTEXT_INSTRUCTIONS],
      ["üres találat", EMPTY_RESULT_INSTRUCTIONS],
      ["üzemzavar", SEARCH_UNAVAILABLE_INSTRUCTIONS],
      ["van találat", "<<<TERMEKADAT>>>\n[]\n<<<TERMEKADAT VEGE>>>"]
    ] as const;

    for (const [label, productContext] of states) {
      const instructions = chatInstructions(
        { ok: true, mode: "anonymous" },
        productContext
      );

      assert.ok(
        instructions.includes(GLOSSARY_INSTRUCTIONS),
        `${label}: a szójegyzék kimaradt a promptból`
      );
    }
  });

  /**
   * A mérés szerint a modell hatból négyszer a `fehérjehabozó (protein
   * skimmer)` párost írja. Egy szabály, ami csak az előírt alakot nevezi meg,
   * ezt nem szünteti meg: a válasz lehet `lehabzó (protein skimmer)`, és a
   * kerülendő szó ugyanúgy ott marad.
   */
  it("külön mondja ki, hogy köznévnél az angol zárójel sem kell", () => {
    assert.match(GLOSSARY_INSTRUCTIONS, /zárójelben sem kell/i);
    assert.match(GLOSSARY_INSTRUCTIONS, /protein skimmer/);
  });

  /**
   * A két szabály látszólag ellentmond egymásnak, ezért kell mindkettőnek
   * külön állnia: rövidítésnél KELL az angol alak, köznévnél NEM.
   */
  it("a rövidítést viszont kibontatja, első előforduláskor", () => {
    assert.match(GLOSSARY_INSTRUCTIONS, /Automatic Top Off/);
    assert.match(GLOSSARY_INSTRUCTIONS, /másodszor már/i);
  });

  it("mind a három kerülendő alakot megnevezi, amit a brief előír", () => {
    for (const term of [
      "zátonyakvárium",
      "sósvízi irányultság",
      "sósvizes akvarisztika"
    ]) {
      assert.ok(
        GLOSSARY_INSTRUCTIONS.includes(term),
        `hiányzik a kerülendő alak: ${term}`
      );
    }
  });

  /**
   * Egy szójegyzék-szabály tipikus mellékhatása, hogy a modell mindenhova
   * beteszi a preferált szót. A #25 kérdéskészletében ezt a
   * `glossary-not-forced` kérdés méri; itt az a garancia, hogy a prompt maga
   * is kimondja.
   */
  it("kimondja, hogy nem kell mindenhova beletenni", () => {
    assert.match(GLOSSARY_INSTRUCTIONS, /ne told bele/i);
  });
});
