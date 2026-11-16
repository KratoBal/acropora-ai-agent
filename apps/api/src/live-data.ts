/**
 * ÉLŐ VAGY AKTUÁLIS ADAT (Acropora OS kártya 7a5ea203, Balázs 2026-08-27 19:37, 1. szabály).
 *
 * A szolgáltatásnak nincs élő adatforrása: nem kérdez le időjárást, hőmérsékletet vagy bármi mást, ami
 * percről percre változik. A szabály ezért az alap-utasítás része, feltétel nélkül, és nem az előszűrőé:
 * az előszűrő alapból ki van kapcsolva (`AI_CHAT_PREFILTER`), és csak a nem témába vágó kérdést fogja meg.
 *
 * BALÁZS SZÖVEGE ÉS A KÉSŐBBI SZŰKÍTÉSE EGYÜTT. A 19:37-es szabály azt is kérte, hogy a modell „mondja el,
 * hogyan ellenőrizhető"; a 20:14-es döntése (mátrix 17. sor) viszont azt, hogy külső szolgáltatást MÉG
 * TÍPUSKÉNT SE nevezzünk meg. A kettő együtt: segíthet megfogalmazni a kérdést, de nem mondja meg, hol
 * vagy mivel nézze meg. A szűkebb nyer.
 *
 * ÉS AMIT NEM ÉRINT: a felhasználó saját mérése. Egy megadott vízhőfokkal vagy KH-értékkel a modell
 * dolgozik; a szabály a modell SAJÁT állításáról szól, nem a felhasználóéról. Ezt a kérdéskészlet
 * `live-data-own-measurement` kérdése méri, mert egy szabály, ami ezt is elutasítja, rosszabb a semminél.
 */
export const LIVE_DATA_INSTRUCTIONS = [
  "ÉLŐ VAGY AKTUÁLIS ADAT. Nincs élő adatforrásod: nem látod az időjárást, a",
  "kinti hőmérsékletet, és semmi mást, ami folyamatosan változik.",
  "",
  "Ilyen adatról ne állíts értéket, és ne sugalld, hogy lekérdezted vagy",
  "megnézted. Mondd ki egyszerűen, hogy erről nincs információd.",
  "",
  "Ha a felhasználó megadja a várost, segíthetsz pontosan megfogalmazni a",
  "kérdését, de ne mondd meg, hol vagy mivel nézze meg: külső szolgáltatást,",
  "oldalt vagy alkalmazást még típusként se nevezz meg.",
  "",
  "A felhasználó SAJÁT mérését ez nem érinti: ha megadja a vízhőfokot vagy",
  "egy mért értéket, azzal dolgozz."
].join("\n");
