import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";

/**
 * MI TÖRTÉNT EZZEL A KÉRDÉSSEL - MIND A HÁROM KIJÁRATON.
 *
 * A felhasználói üzenet a modellhívás ELŐTT mentődik, tehát egy meg nem
 * válaszolt kérdés szövege nem vész el. Ami eddig elveszett, az az OK volt: a
 * megnevezett hiba a naplóba és a hívónak ment, az adatbázisba nem. Ettől egy
 * válasz nélküli sor megkülönböztethetetlen volt attól, hogy időtúllépés
 * történt, a szolgáltató hibázott, vagy a kulcs hiányzott.
 *
 * A siker azért ír kódot ('answered') ahelyett, hogy NULL-t hagyna, mert
 * különben a NULL három dolgot jelentene egyszerre: sikerült, a sor régebbi
 * mint az oszlop, vagy egy kijárat elfelejtett írni. Így csak az utóbbi kettőt
 * jelenti, és mindkettő olyan, amit látni akarunk.
 */

const API_TOKEN = "outcome-teszt-kulcs";
const QUESTION_ID = "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

function storeRecording(noted: Array<{ id: string; outcome: string }>) {
  return {
    createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
    conversationBelongsToClient: async () => true,
    saveMessage: async (input: { role: string }) =>
      input.role === "assistant"
        ? "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f"
        : QUESTION_ID,
    setMessageOutcome: async (id: string, outcome: string) => {
      noted.push({ id, outcome });
    },
    getConversationMessages: async () => []
  } as unknown as ConversationStore;
}

async function ask(
  store: ConversationStore,
  openai: NonNullable<AppDependencies["openai"]>
) {
  const app = buildApp({ conversations: store, openai });
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat",
    headers: { authorization: `Bearer ${API_TOKEN}` },
    payload: { message: "Melyik szűrő kell 200 literhez?" }
  });

  await app.close();
  return response;
}

const answering = {
  responses: { create: async () => ({ output_text: "valasz" }) }
} as unknown as NonNullable<AppDependencies["openai"]>;

describe("mi történt ezzel a kérdéssel", () => {
  /**
   * MINEK KELL PIROSÍTANIA: ha a siker nem ír kódot, vagy nem a KÉRDÉS sorára
   * írja. Az utóbbi azért fontos, mert a válasz sora nem létezik minden
   * kimenetelben - a kérdésé igen.
   */
  it("sikeres válasznál 'answered' kerül a KÉRDÉS sorára", async () => {
    const noted: Array<{ id: string; outcome: string }> = [];

    const response = await ask(storeRecording(noted), answering);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(noted, [{ id: QUESTION_ID, outcome: "answered" }]);
  });

  /**
   * MINEK KELL PIROSÍTANIA: ha a szolgáltató hibája után a sor jelöletlen
   * marad - mert onnantól nem különböztethető meg egy sikeres futástól.
   */
  it("a szolgáltató hibája a megnevezett okot írja le", async () => {
    const noted: Array<{ id: string; outcome: string }> = [];
    const failing = {
      responses: {
        create: async () => {
          throw new Error("boom");
        }
      }
    } as unknown as NonNullable<AppDependencies["openai"]>;

    const response = await ask(storeRecording(noted), failing);

    assert.equal(response.statusCode, 502);
    assert.deepEqual(noted, [{ id: QUESTION_ID, outcome: "ai_provider_error" }]);
  });

  /**
   * ÉS AMI A LEGFONTOSABB: a jegyzet SOHA nem kerülhet a válasz elé.
   *
   * MINEK KELL PIROSÍTANIA: ha egy elbukó UPDATE elrontja a választ. Egy már
   * megkért és kifizetett modellhívás nem veszhet el azon, hogy egy széljegyzet
   * nem íródott le.
   */
  it("ha a jegyzet írása elhasal, a válasz akkor is megérkezik", async () => {
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async () => QUESTION_ID,
      setMessageOutcome: async () => {
        throw new Error("az adatbazis nem elerheto");
      },
      getConversationMessages: async () => []
    } as unknown as ConversationStore;

    const response = await ask(store, answering);

    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).answer, "valasz");
  });
});
