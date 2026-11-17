import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatInstructions } from "./app.js";
import {
  ABBREVIATIONS,
  abbreviationLine,
  GLOSSARY_AVOIDED,
  GLOSSARY_INSTRUCTIONS,
  GLOSSARY_PREFERRED
} from "./glossary.js";
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

  /*
    THE FOLLOW-UP THAT EXPANDS AGAIN (card 660258d8, task t-20261117-ai-roviditesi-szabaly; acrobot 55049). The question-set follow-up
    "Az előbb említett ATO-nál mekkora tartály elég egy hétre?" got its ATO expanded a second time in both genuine runs (09:15 and 18:30 UTC,
    the 09:30 one followed a doseGuard replacement, so the history held no expansion): the answer opened with the same
    "Az ATO (Automatic Top Off – ...)" as the previous one. The model receives the whole history, so the rule is about WHAT it is told. THIS TEST
    SAYS THE SENTENCES ARE IN THE INSTRUCTION; it cannot say the model obeys them: that is the next question-set run's measure (the
    instruction's version changes with its text). WHAT TURNS IT RED: a sentence going missing.
  */
  it("a kibontás beszélgetésenként egyszer történik: a korábbi válaszokat nézi, a kérdés említése és a nyitómondat másolása nem számít újabb első előfordulásnak", () => {
    assert.match(GLOSSARY_INSTRUCTIONS, /beszélgetésenként\s+egyszer/i);
    assert.match(GLOSSARY_INSTRUCTIONS, /korábbi\s+válaszaidat/i);
    assert.match(GLOSSARY_INSTRUCTIONS, /SOHA\s+ne\s+bontsd\s+ki\s+újra/);
    assert.match(GLOSSARY_INSTRUCTIONS, /az\s+előbb\s+említett\s+ATO/i);
    assert.match(GLOSSARY_INSTRUCTIONS, /nyitómondatát\s+ne\s+másold/i);
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

/*
  A RÖVIDÍTÉS-LISTA (kártya 7a5ea203). MI PIROSÍT: Balázs hat példájából egy hiányzik; a KH angol forrást kap (a szabály
  az eredeti kifejezést kéri, és a KH német); egy rövidítés két sorban áll; vagy a lista nem jut el az utasításig.
*/
describe("a rövidítések listája", () => {
  it("Balázs hat példája mind benne van, egyszer", () => {
    const names = ABBREVIATIONS.map((entry) => entry.abbreviation);
    assert.deepEqual([...names].sort(), ["ATO", "ICP", "KH", "PAR", "RO", "TDS"]);
    assert.equal(new Set(names).size, names.length);
  });

  it("a KH német forrással áll, és a szabály az eredeti kifejezést kéri, nem az angolt", () => {
    const kh = ABBREVIATIONS.find((entry) => entry.abbreviation === "KH");
    assert.equal(kh?.language, "de");
    assert.equal(abbreviationLine(kh!), "KH (Karbonathärte, német - karbonátkeménység)");
    assert.match(GLOSSARY_INSTRUCTIONS, /az eredeti kifejezéssel ÉS magyarul/);
    assert.doesNotMatch(GLOSSARY_INSTRUCTIONS, /bontsd ki\s+angolul/);
  });

  it("minden sor eljut az utasításig", () => {
    for (const entry of ABBREVIATIONS)
      assert.ok(
        GLOSSARY_INSTRUCTIONS.includes(abbreviationLine(entry)),
        `${entry.abbreviation}: hiányzik az utasításból`
      );
  });
});

describe("az alakok listája a futtatónak", () => {
  // a szöveg kézzel tördelt, a lista külön áll: ha szétcsúsznak, a futtató mást számol, mint amit a modell kap
  it("minden előírt és kerülendő alak a szövegben is ott van", () => {
    const flat = GLOSSARY_INSTRUCTIONS.replace(/\s+/g, " ");
    for (const term of [...GLOSSARY_PREFERRED, ...GLOSSARY_AVOIDED])
      assert.ok(flat.includes(term), `${term}: nincs a szójegyzék szövegében`);
  });
});
