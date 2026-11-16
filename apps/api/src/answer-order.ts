/**
 * A VÁLASZ SORRENDJE, MINDEN ÁGBAN (Acropora OS kártya 7a5ea203, t-20261116-ai-utasitas-hangolas).
 *
 * A szabály eddig csak két termékkontextus-ágban állt: a „nincs katalógus” (`no-product-context.ts`, „And say it
 * first”) és a „keresési hiba” ágban („de ne ezzel kezdd a választ”). Az „üres találat” és a találatos ág nem kapta
 * meg, és egyik sem része a rögzített utasításnak, tehát az `instructionsVersion` sem mozdult volna a változásukkal. A
 * kérdéskészlet mindhárom stage-futásán az `order-world-knowledge-first` válasza a korláttal nyitott („Azt, hogy nálunk
 * pontosan mi mennyibe kerül, ... nem látom”).
 *
 * EZÉRT A RÖGZÍTETT RÉSZBEN ÁLL, feltétel nélkül, a nyelvi szabályok mellett: egy termékkontextus-üzemzavar nem viheti
 * el, és a változása a válasz mellé írt verzióban is látszik. Az ágak saját szövege változatlan; ez nem mond nekik
 * ellent, csak mindenhova eljuttatja ugyanazt.
 */
export const ANSWER_ORDER_INSTRUCTIONS = [
  "A VÁLASZ SORRENDJE. Amit a világról tudsz, az áll a válasz elején: az első",
  "mondat a kérdés tárgyáról szól (mi ez, mire jó, mitől jó, mire figyelj).",
  "",
  "Ha a kérdés a mi árunkra, készletünkre vagy kínálatunkra is rákérdezett, és",
  "azt nem látod, ezt EGY tagmondatban mondd ki, a válasz belsejében vagy a",
  "végén. Soha ne ezzel nyiss, és ne tedd címbe vagy külön bekezdés élére.",
  "",
  "Ha a kérdés nem a kínálatunkról szól, a korlátot egyáltalán ne említsd."
].join("\n");
