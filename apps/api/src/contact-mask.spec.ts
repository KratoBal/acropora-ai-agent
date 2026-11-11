import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTACT_PLACEHOLDER,
  MASK_CONTACTS_ENV,
  maskContacts,
  maskContactsEnabled
} from "./contact-mask.js";

const masked = (text: string) => maskContacts(text).text;

describe("the contact mask: what IS a contact", () => {
  it("masks Hungarian telephone numbers in the shapes people type", () => {
    for (const number of [
      "+36 30 123 4567",
      "+36301234567",
      "+36-30-123-4567",
      "06 30 123 4567",
      "06301234567",
      "06-30/123-4567",
      "06 (30) 123 45 67",
      "06 30 123 45 67",
      "0036 30 123 4567",
      "06 1 234 5678", // Budapest: area code 1, seven digits
      "+36 1 234 5678",
      "06 52 123 456" // a two-digit area code with six digits
    ])
      assert.equal(
        masked(`Hívjon ezen: ${number}, köszönöm.`),
        `Hívjon ezen: ${CONTACT_PLACEHOLDER}, köszönöm.`,
        number
      );
  });

  it("masks e-mail addresses, whatever the case or the subdomains", () => {
    for (const address of [
      "kovacs.janos@example.hu",
      "Kovacs+akvarium@Example.COM",
      "a_b-c@mail.sub.example.co.uk",
      "info@acropora.hu"
    ])
      assert.equal(masked(`Írjon ide: ${address}.`), `Írjon ide: ${CONTACT_PLACEHOLDER}.`, address);
  });

  it("counts what it replaced, and only the number leaves this function as data", () => {
    const result = maskContacts("kovacs@example.hu vagy +36 30 123 4567, illetve 06 20 987 6543");
    assert.equal(result.masked, 3);
    assert.equal(result.text, `${CONTACT_PLACEHOLDER} vagy ${CONTACT_PLACEHOLDER}, illetve ${CONTACT_PLACEHOLDER}`);
  });

  it("a number glued to a letter is still a number: `Tel:+36...`", () => {
    assert.equal(masked("Tel:+36301234567"), `Tel:${CONTACT_PLACEHOLDER}`);
  });

  it("a telephone number inside an address does not leave a half-masked rest", () => {
    assert.equal(masked("level06301234567@example.hu"), CONTACT_PLACEHOLDER);
  });
});

describe("the contact mask: what is NOT a contact (barracuda's point 3: an order number is no telephone number)", () => {
  it("leaves order, part and invoice numbers, dates, prices and measurements alone", () => {
    for (const text of [
      "A rendelésszámom 1234567890.",
      "Rendelés: ORD-2026-0042, számla ACRS-2026-1",
      "Termékkód 06-ABC-1234",
      "A szállítás 2026-11-11 és 2026.11.12. között érkezik.",
      "120 000 Ft helyett 99 900 Ft",
      "1 500 000 forint",
      "KH 7,5 dKH, nitrát 5 mg/l, foszfát 0,03, szalinitás 1,025",
      "ICP eredmény: Ca 420, Mg 1350, K 400",
      "Hány fok legyen 06:30-kor?",
      "Az ár 06 30 euró", // too short to be a number
      "számlaszám 11773016-12345678-00000000"
    ])
      assert.equal(masked(text), text, text);
  });

  it("a long digit string is no telephone number, with or without the prefix", () => {
    for (const text of ["06301234567890", "+3630123456789012", "kód: 1006301234567"])
      assert.equal(masked(text), text, text);
  });

  it("an incomplete address is left alone", () => {
    for (const text of ["kovacs@", "a@b", "@example.hu", "ár 5@6.5 db", "x@y.z"])
      assert.equal(masked(text), text, text);
  });

  it("a number from another country or without its prefix is NOT caught (the mask is a floor, not a promise)", () => {
    for (const text of ["+44 20 7946 0958", "30 123 4567", "301234567"])
      assert.equal(masked(text), text, text);
  });

  it("an empty text is an empty text", () => {
    assert.deepEqual(maskContacts(""), { text: "", masked: 0 });
  });
});

describe("the switch", () => {
  it("is ON unless exactly `false`: a privacy floor is not an opt-in", () => {
    assert.equal(maskContactsEnabled({}), true);
    for (const value of ["", "true", "FALSE", "0", "off", " false"])
      assert.equal(maskContactsEnabled({ [MASK_CONTACTS_ENV]: value }), true, JSON.stringify(value));
    assert.equal(maskContactsEnabled({ [MASK_CONTACTS_ENV]: "false" }), false);
  });
});
