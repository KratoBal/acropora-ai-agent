import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, type AppDependencies } from "./app.js";
import { JSON_INPUT_LEAD } from "./claim-extraction.js";
import {
  FIGURE_BODY_LIMIT,
  MAX_CAPTION,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TRANSCRIPT,
  figureClaimInput,
  figureClaimInstructions,
  guardFigureClaims,
  parseFigureRequest,
  type FigureClaimRequest
} from "./figure-claim-extraction.js";

/**
 * THE FIGURE CLAIM EXTRACTION (research-kepes-ut). WHAT TURNS IT RED: a claim
 * that does not say whether its passage stands in the caption (checkable) or
 * in a tile's transcript (the model's word); a passage joined across the two;
 * a number that is not printed (read off a curve) getting through as a
 * quantity; an image whose bytes are not what the caller says; the route
 * without its token, its shape check or its own body limit. Invented text and
 * fake image bytes only: the guard reads the magic bytes, the model is a stub.
 */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const png = (bytes: Buffer = PNG_BYTES) => ({ contentType: "image/png" as const, data: bytes.toString("base64") });

const CAPTION =
  "Figure 3. Calcification of Acropora millepora at three phosphate levels. Calcification decreased at 2 µM phosphate.";
const TILE_1 = "A\nPO4 (µM)\n0 | 0.5 | 2 |\nCalcification (mg cm-2 d-1)";
const TILE_2 = "B\nSkeletal density\n2 µM PO4: no change";

const REQUEST: FigureClaimRequest = {
  subject: "PHOSPHATE",
  vocabulary: {
    taxa: ["ACROPORA", "ACROPORA_MILLEPORA"],
    environments: ["FIELD", "LAB"],
    effects: ["CALCIFICATION", "SKELETAL_DENSITY"]
  },
  figure: "Figure 3",
  caption: CAPTION,
  images: [png(), png()]
};

const answer = (body: Record<string, unknown>) => JSON.stringify({ transcripts: [TILE_1, TILE_2], ...body });

describe("parseFigureRequest", () => {
  it("accepts a figure, its caption and its tiles", () => {
    const parsed = parseFigureRequest(REQUEST);
    assert.ok(parsed.ok);
    assert.equal(parsed.request.images.length, 2);
    assert.equal(parseFigureRequest({ ...REQUEST, images: [{ contentType: "image/jpeg", data: JPEG_BYTES.toString("base64") }] }).ok, true);
  });

  it("refuses a missing caption, a bad label, no tile, too many tiles, and the text check's own refusals", () => {
    for (const body of [
      { ...REQUEST, caption: "" },
      { ...REQUEST, caption: "x".repeat(MAX_CAPTION + 1) },
      { ...REQUEST, figure: "" },
      { ...REQUEST, figure: "Figure\u00073" },
      { ...REQUEST, images: [] },
      { ...REQUEST, images: Array.from({ length: MAX_IMAGES + 1 }, () => png()) },
      { ...REQUEST, subject: "NITRATE" },
      { ...REQUEST, vocabulary: { ...REQUEST.vocabulary, taxa: [] } },
      null
    ])
      assert.equal(parseFigureRequest(body).ok, false, JSON.stringify(body)?.slice(0, 80));
  });

  it("the kind comes from the bytes: a JPEG called PNG, a GIF, or not base64 is refused", () => {
    for (const image of [
      { contentType: "image/png", data: JPEG_BYTES.toString("base64") },
      { contentType: "image/jpeg", data: PNG_BYTES.toString("base64") },
      { contentType: "image/gif", data: PNG_BYTES.toString("base64") },
      { contentType: "image/png", data: "not base64!" },
      { contentType: "image/png", data: `data:image/png;base64,${PNG_BYTES.toString("base64")}` }
    ]) {
      const parsed = parseFigureRequest({ ...REQUEST, images: [image] });
      assert.equal(parsed.ok, false, image.contentType + " " + image.data.slice(0, 12));
    }
  });

  it("an image over the per-tile cap is refused, and one at the cap is not", () => {
    const at = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_IMAGE_BYTES - PNG_BYTES.byteLength)]);
    assert.equal(parseFigureRequest({ ...REQUEST, images: [png(at)] }).ok, true);
    const over = Buffer.concat([at, Buffer.alloc(1)]);
    const parsed = parseFigureRequest({ ...REQUEST, images: [png(over)] });
    assert.deepEqual(parsed, { ok: false, error: `images[0]: at most ${MAX_IMAGE_BYTES} bytes` });
  });
});

describe("figureClaimInstructions", () => {
  it("asks for printed text only, never a value read off a mark, and shares the text extraction's rules", () => {
    const instructions = figureClaimInstructions(REQUEST);
    for (const rule of [
      /ONLY printed text: never a value you read off a bar, a point, a line or a colour/,
      /never from where a mark stands on an axis/,
      /from the caption OR from ONE tile's transcript, never joined across them/,
      /Every field's anchor comes from a part its claim may rest on/,
      /2 tiles in reading order/,
      // the text extraction's own rules, the same words
      /Only findings this text reports as ITS OWN result/,
      /the anchor must contain the number, the unit and the word that says which/,
      /ACROPORA_MILLEPORA/
    ])
      assert.match(instructions, rule);
  });

  it("hands the caption as data and every tile as a high-detail image, in order", () => {
    const [message] = figureClaimInput(REQUEST);
    assert.equal(message!.content.length, 3);
    const text = (message!.content[0] as { text: string }).text;
    assert.ok(text.startsWith(`${JSON_INPUT_LEAD} `));
    assert.deepEqual(JSON.parse(text.slice(JSON_INPUT_LEAD.length + 1)), {
      subject: "PHOSPHATE",
      figure: "Figure 3",
      caption: CAPTION
    });
    for (const part of message!.content.slice(1))
      assert.deepEqual(part, {
        type: "input_image",
        image_url: `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
        detail: "high"
      });
  });
});

describe("guardFigureClaims", () => {
  it("a caption passage is CAPTION, a transcript passage names its tile", () => {
    const guarded = guardFigureClaims(
      answer({
        claims: [
          {
            passage: { text: "Calcification decreased at 2 µM phosphate.", locator: "panel A" },
            fields: {
              direction: { value: "DECREASE", anchor: "Calcification decreased" },
              quantity: { min: 2, max: 2, unit: "µmol/l", basis: null, anchor: "2 µM phosphate" }
            }
          },
          {
            passage: { text: "2 µM PO4: no change", locator: "panel B" },
            fields: {
              effect: { value: "SKELETAL_DENSITY", anchor: "Skeletal density" },
              direction: { value: "NONE", anchor: "no change" },
              quantity: { min: 2, max: 2, unit: "µmol/l", basis: null, anchor: "2 µM PO4" }
            }
          }
        ]
      }),
      REQUEST
    );
    assert.ok(guarded.ok);
    assert.deepEqual(
      guarded.claims.map((c) => c.origin),
      [{ part: "CAPTION" }, { part: "IMAGE", tile: 2 }]
    );
    assert.deepEqual(
      guarded.claims.map((c) => c.fields.map((f) => f.field)),
      [
        ["direction", "quantity"],
        ["effect", "direction", "quantity"]
      ]
    );
    assert.deepEqual(guarded.transcripts, [TILE_1, TILE_2].map((t) => t.replace(/\s+/g, " ").trim()));
  });

  it("a number read off a curve, not printed, does not become a quantity", () => {
    const guarded = guardFigureClaims(
      answer({
        claims: [
          {
            passage: { text: "Calcification (mg cm-2 d-1)", locator: "panel A" },
            fields: { quantity: { min: 1.4, max: 1.4, unit: "µmol/l", basis: null, anchor: "PO4 (µM)" } }
          }
        ]
      }),
      REQUEST
    );
    assert.ok(guarded.ok);
    assert.deepEqual(guarded.claims[0]!.fields, []);
    assert.deepEqual(guarded.claims[0]!.refusedFields, [{ field: "quantity", refusal: "NUMBER_NOT_IN_ANCHOR" }]);
  });

  it("a passage joined across the caption and a tile, or across two tiles, is refused", () => {
    const guarded = guardFigureClaims(
      answer({
        claims: [
          { passage: { text: "Calcification decreased at 2 µM phosphate. A PO4 (µM)", locator: "x" }, fields: {} },
          { passage: { text: "Calcification (mg cm-2 d-1) B Skeletal density", locator: "x" }, fields: {} }
        ]
      }),
      REQUEST
    );
    assert.ok(guarded.ok);
    assert.equal(guarded.claims.length, 0);
    assert.deepEqual(guarded.refusedClaims, [{ refusal: "PASSAGE_ACROSS_PARTS" }, { refusal: "PASSAGE_ACROSS_PARTS" }]);
  });

  it("a CAPTION claim drops a number only a tile holds; an IMAGE claim keeps the caption's words, not another tile's", () => {
    const guarded = guardFigureClaims(
      answer({
        claims: [
          {
            passage: { text: "Calcification decreased at 2 µM phosphate.", locator: "x" },
            fields: {
              direction: { value: "DECREASE", anchor: "Calcification decreased" },
              // "2 µM PO4" stands only in tile 2's transcript
              quantity: { min: 2, max: 2, unit: "µmol/l", basis: null, anchor: "2 µM PO4" }
            }
          },
          {
            passage: { text: "2 µM PO4: no change", locator: "panel B" },
            fields: {
              direction: { value: "NONE", anchor: "no change" },
              // the caption's words: checkable, so an image claim may rest on them
              species: { value: "ACROPORA_MILLEPORA", anchor: "Acropora millepora" },
              // tile 1's words, not tile 2's
              effect: { value: "CALCIFICATION", anchor: "Calcification (mg cm-2 d-1)" }
            }
          }
        ]
      }),
      REQUEST
    );
    assert.ok(guarded.ok);
    assert.deepEqual(
      guarded.claims.map((c) => [c.origin, c.fields.map((f) => f.field), c.refusedFields]),
      [
        [{ part: "CAPTION" }, ["direction"], [{ field: "quantity", refusal: "ANCHOR_ACROSS_PARTS" }]],
        [{ part: "IMAGE", tile: 2 }, ["direction", "species"], [{ field: "effect", refusal: "ANCHOR_ACROSS_PARTS" }]]
      ]
    );
  });

  it("an anchor across the caption's end and a tile's start is dropped, and so is a question's", () => {
    const guarded = guardFigureClaims(
      answer({
        claims: [
          {
            passage: { text: "Calcification decreased at 2 µM phosphate.", locator: "x" },
            fields: {
              direction: { value: "DECREASE", anchor: "Calcification decreased" },
              quantity: { min: 2, max: 2, unit: "µmol/l", basis: null, anchor: "2 µM phosphate. A PO4" },
              species: { value: "Pocillopora", anchor: "B Skeletal density" }
            }
          }
        ]
      }),
      REQUEST
    );
    assert.ok(guarded.ok);
    const [claim] = guarded.claims;
    assert.deepEqual(claim!.fields.map((f) => f.field), ["direction"]);
    assert.deepEqual(claim!.questions, []);
    assert.deepEqual(claim!.refusedFields, [
      { field: "quantity", refusal: "ANCHOR_ACROSS_PARTS" },
      { field: "species", refusal: "ANCHOR_ACROSS_PARTS" }
    ]);
  });

  it("an invented passage is refused by the text guard, with where it leaves", () => {
    const guarded = guardFigureClaims(
      answer({ claims: [{ passage: { text: "Calcification increased sharply", locator: "x" }, fields: {} }] }),
      REQUEST
    );
    assert.ok(guarded.ok);
    assert.equal(guarded.claims.length, 0);
    assert.equal(guarded.refusedClaims[0]!.refusal, "PASSAGE_NOT_IN_TEXT");
  });

  it("no transcripts, the wrong number of them, or one too long refuses the whole answer", () => {
    const claims = { claims: [] };
    assert.deepEqual(guardFigureClaims(JSON.stringify(claims), REQUEST), {
      ok: false,
      refusal: "NO_TRANSCRIPTS",
      detail: "transcripts 0/2 -"
    });
    assert.deepEqual(guardFigureClaims(JSON.stringify({ transcripts: [TILE_1], ...claims }), REQUEST), {
      ok: false,
      refusal: "NO_TRANSCRIPTS",
      detail: "transcripts 1/2 -"
    });
    assert.deepEqual(
      guardFigureClaims(JSON.stringify({ transcripts: [TILE_1, "x".repeat(MAX_TRANSCRIPT + 1)], ...claims }), REQUEST),
      { ok: false, refusal: "TRANSCRIPT_TOO_LONG" }
    );
    assert.equal(guardFigureClaims("nem json", REQUEST).ok, false);
  });
});

describe("POST /v1/figure-claim-extractions", () => {
  const API_TOKEN = "test-api-access-token";
  const saved = { ...process.env };
  let handed: { instructions?: unknown; input?: unknown; text?: unknown } = {};
  let modelText = "";
  const modelClient = {
    responses: {
      create: async (parameters: { instructions?: unknown; input?: unknown; text?: unknown }) => {
        handed = parameters;
        return { output_text: modelText };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;
  let app: ReturnType<typeof buildApp>;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    app = buildApp({ openai: modelClient });
    await app.ready();
  });

  after(async () => {
    await app.close();
    process.env = saved;
  });

  const call = (url: string, payload: unknown, token: string | null = API_TOKEN) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json"
      },
      payload: JSON.stringify(payload)
    });

  it("FIGURE-ROUTE: the token gate, the shape check, claims with their origin and the transcripts", async () => {
    modelText = answer({
      claims: [
        {
          passage: { text: "2 µM PO4: no change", locator: "panel B" },
          fields: { direction: { value: "NONE", anchor: "no change" } }
        }
      ]
    });
    const url = "/v1/figure-claim-extractions";
    const unauthorized = await call(url, REQUEST, null);
    const malformed = await call(url, { ...REQUEST, images: [] });
    const answered = await call(url, REQUEST);
    assert.deepEqual([unauthorized.statusCode, malformed.statusCode, answered.statusCode], [401, 400, 200]);
    const body = answered.json();
    assert.deepEqual(body.claims[0].origin, { part: "IMAGE", tile: 2 });
    assert.equal(body.transcripts.length, 2);
    assert.equal(body.extractedBy, `${process.env.OPENAI_MODEL ?? "gpt-5.1"} figure-claim-extraction/v2`);
    assert.match(String(handed.instructions), /ONLY printed text/);
    assert.match(JSON.stringify(handed.input), /"type":"input_image"/);
    assert.deepEqual(handed.text, { format: { type: "json_object" } });
    const [message] = handed.input as { content: { type: string; text?: string }[] }[];
    assert.match(String(message!.content[0]!.text), /^The input, as JSON data/);

    modelText = "nem json";
    const refused = await call(url, REQUEST);
    assert.deepEqual([refused.statusCode, refused.json().refusal], [200, "NOT_JSON"]);
  });

  it("the token is checked before the body is read: no token and a broken body is 401, not 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/figure-claim-extractions",
      headers: { "content-type": "application/json" },
      payload: "{"
    });
    assert.equal(response.statusCode, 401);
    // the same body with the token is the parser's 400: the order above is the hook's
    const withToken = await app.inject({
      method: "POST",
      url: "/v1/figure-claim-extractions",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      payload: "{"
    });
    assert.equal(withToken.statusCode, 400);
  });

  it("the route has its own body limit: a 2 MB tile goes through here, and the text route still refuses that size", async () => {
    assert.ok(FIGURE_BODY_LIMIT > 30 * 1024 * 1024);
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]);
    modelText = JSON.stringify({ transcripts: [""], claims: [] });
    const figure = await call("/v1/figure-claim-extractions", { ...REQUEST, images: [png(big)] });
    assert.equal(figure.statusCode, 200);
    const text = await call("/v1/claim-extractions", {
      sourceText: "x",
      subject: "PHOSPHATE",
      vocabulary: REQUEST.vocabulary,
      padding: big.toString("base64")
    });
    assert.equal(text.statusCode, 413);
  });
});
