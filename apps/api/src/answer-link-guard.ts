import { domainToASCII } from "node:url";

import { IANA_TLDS } from "./iana-tlds.js";
import type { ProductSearchOutcome } from "./product-search.js";

/**
 * NO EXTERNAL LINK LEAVES BY DEFAULT (Acropora OS card 9d060f5c; Balázs's rule,
 * card comment 728, 2026-08-27; plan v3 sections 3-5). The answer the customer
 * gets is read here, and every address in it - a URL, a scheme-less or `www.`
 * address, a bare domain on a real TLD, an IP, a bracketed or spelled-out
 * address - is a violation unless it is our own domain (`acropora.hu` and its
 * subdomains, label-boundary match) or one of three exceptions holds over the
 * STORED source list (the OS's, read by `link-sources.ts`; an empty or unread
 * list leaves none active; acrobot on the card, 736: an exceptional URL only
 * from a stored source, never from the model's memory).
 *
 * Behind `AI_LINK_RULE`: `off` (the default) runs nothing; `log` leaves the
 * answer as it is and reports the violation (reason + host, never the full
 * URL); `enforce` replaces the whole answer with one fixed sentence, like the
 * dose guard (cutting a URL out would leave half a sentence). `enforce` waits
 * for Balázs's approval of that sentence; the code does not.
 *
 * WHAT IS NOT RECOGNISED, SAID OUT LOUD (plan 5.1): a spelled or spaced-out
 * address ("e v i l . c o m"), an address in an image or a file, and a
 * reference to an external service with no address ("keress rá a Google-ben").
 * The last one is forbidden by the instruction (R1) only; the log shows
 * whether it needs a machine guard.
 */

export type LinkRuleMode = "off" | "log" | "enforce";

export const LINK_RULE_ENV = "AI_LINK_RULE";

/** Exactly `log` or `enforce`; anything else (unset, a typo, upper case) is `off`. Read per call. */
export const linkRuleMode = (env: NodeJS.ProcessEnv = process.env): LinkRuleMode => {
  const value = env[LINK_RULE_ENV];
  return value === "log" || value === "enforce" ? value : "off";
};

/**
 * THE SENTENCE THAT REPLACES A VIOLATING ANSWER UNDER `enforce`. A PROPOSAL,
 * NOT BALÁZS'S TEXT (plan 6.2, acrobot 46815 and 46822): informal like the
 * rest of the chat, and with no colleague offer (that is off until slice 4d).
 * `enforce` must not be switched on before he approves it; the approved text
 * replaces this constant and nothing else.
 */
export const LINK_GUARD_FALLBACK =
  "Ehhez nem tudok linket adni. Ha a termékről vagy a rendelésedről kérdezel, szívesen segítek itt.";

/**
 * R1: the rule, told to the model under `log` and `enforce`. NOT A PROTECTION
 * on its own (barracuda on #42: the prompt is not a guard); the gate below is.
 */
export const LINK_RULE_INSTRUCTIONS = [
  "KÜLSŐ LINKEK ÉS FORRÁSOK:",
  "- Ne adj külső webcímet (URL-t, domaint), és ne küldd a felhasználót külső weboldalra.",
  "- Ne ajánlj keresőt, időjárás-oldalt, fórumot, más webshopot vagy más külső szolgáltatást, név szerint vagy típusként sem.",
  "- Ha egy adatot nem látsz, ne külső forrásra hivatkozz: mondd ki, hogy nincs róla adatod, adj rövid választ abból, amit tudsz, vagy kérdezz vissza.",
  "- Kivétel csak az lehet, ha a felhasználó kifejezetten linket vagy forrást kér, ha a pontos válaszhoz hivatalos gyártói dokumentum kell, vagy ha jogi, hatósági, garanciális vagy biztonsági kérdésről van szó. Webcímet ilyenkor is csak akkor adhatsz, ha a rendszer forrásként megadta; emlékezetből soha.",
  "- Az Acropora saját termékeire és tudásanyagára hivatkozhatsz, de webcímet ne találj ki."
].join("\n");

/** Our own domain (acrobot 46815). The UNAS platform domains are NOT own: we are moving off them. */
export const OWN_DOMAIN = "acropora.hu";

export type StoredLinkSourceCategory = "MANUFACTURER_DOCUMENT" | "AUTHORITY";

/** One row of the stored source list (plan section 4). Its owner is the OS; `link-sources.ts` reads it. */
export interface StoredLinkSource {
  host: string;
  category: StoredLinkSourceCategory;
  /** Required for a manufacturer document: the exception binds it to a hit of this brand. */
  brand: string | null;
  note?: string;
}


const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * K1: the user ASKS for a link or a source (plan 4; the list is mine to write,
 * widened from the log). Read on the folded message, so `\b` sees ASCII only.
 * "url" needs a boundary or a hyphen ("URL-t"), else "űrlap" would ask.
 */
export const LINK_REQUEST =
  /\b(?:link\w*|url(?:\b|-)|webcim\w*|weboldal\w*|honlap\w*|forras(?!z)\w*|website\w*|sources?\b|hol olvashat\w*|hol talalom meg az adatlap\w*)/;

/** K3: a legal, authority, warranty or safety question (plan 4). */
export const AUTHORITY_TOPIC =
  /\b(?:garanci\w*|jotallas\w*|szavatossag\w*|jog(?:i|a|om|od|uk|ok|ot|ilag|szabaly\w*)?\b|torveny\w*|hatosag\w*|engedely\w*|cites\b|biztonsagi adatlap\w*|veszelyes\w*|mergez\w*|warrant\w*|safety data sheet\w*|m?sds\b)/;

/**
 * Bare TLDs that are also file extensions (plan 5.1): "kezelesi.zip" and
 * "video.mov" are files. They count only with a scheme or `www.`.
 */
const FILE_EXTENSION_TLDS = new Set(["zip", "mov"]);

/**
 * Words that are TLDs AND the ordinary next word after "pont"/"dot" ("ez pont
 * az", "pont ma", "the dot is"). A spelled-out separator is read only before a
 * TLD that is none of these; a bracketed dot is read before anything.
 */
export const SPELLED_SEPARATOR_STOPWORDS = new Set([
  // Hungarian, folded ("jó" is "jo", "és" is "es")
  "az", "is", "ma", "jo", "ott", "de", "be", "ki", "se", "ne", "mint", "es",
  // English
  "to", "in", "at", "it", "be", "do", "no", "so", "as", "by", "my", "me", "us", "am", "one", "now",
  "new", "how", "you", "best", "top", "fit", "fun", "win", "pro", "plus", "live", "love", "life",
  "care", "fish", "pet", "shop", "tips", "eco", "bio", "red", "blue", "black", "green", "pink", "gold"
]);

export interface FoundLink {
  /** Normalised ASCII host, lower case, no port, no trailing dot; an IP as written. */
  host: string;
  ip: boolean;
  /** The path, when the form carries one ("" otherwise). */
  path: string;
}

const LABEL = "[\\p{L}\\p{M}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?";
// what ends an address in running text: space, quotes, brackets, angle brackets
const URL_BODY = "[^\\s<>\"'`()\\[\\]{}]";

/**
 * The host as the guard compares it: ASCII (IDN to punycode), lower case, the
 * trailing dot off, and a Hungarian case ending off the last label
 * ("acropora.hu-n", "redsea.com-on"): the ending is grammar, not a label.
 * Text that does not normalise (an invalid IDN) stays as it was, lower case:
 * it is never our domain, so it is a violation.
 */
export function normalizeHost(raw: string): string {
  let host = raw.trim().replace(/\.+$/, "");
  const ascii = domainToASCII(host);
  host = (ascii === "" ? host : ascii).toLowerCase().replace(/\.+$/, "");
  const labels = host.split(".");
  const last = labels[labels.length - 1] ?? "";
  const dash = last.indexOf("-");
  if (labels.length > 1 && !IANA_TLDS.has(last) && dash > 0 && IANA_TLDS.has(last.slice(0, dash)))
    labels[labels.length - 1] = last.slice(0, dash);
  return labels.join(".");
}

const isIPv4 = (host: string) =>
  /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255);

/** Host and path out of an address with an authority part; a URL that does not parse still gives its host. */
function fromAuthority(withScheme: string): FoundLink {
  const trimmed = withScheme.replace(/[.,;:!?]+$/, "");
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname;
    if (hostname.startsWith("["))
      return { host: hostname.slice(1, -1), ip: true, path: url.pathname };
    const host = normalizeHost(hostname);
    return { host, ip: isIPv4(host), path: url.pathname };
  } catch {
    const authority = trimmed.replace(/^[^:]*:\/\//, "").split(/[/?#\\]/)[0] ?? "";
    const host = normalizeHost(authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, ""));
    return { host, ip: isIPv4(host), path: "" };
  }
}

const SCHEME_URL = new RegExp(`\\b[a-z][a-z0-9+.-]{1,15}:\\/\\/${URL_BODY}+`, "giu");
const SCHEMELESS_URL = new RegExp(`(?<![\\p{L}\\p{N}:/])\\/\\/${URL_BODY}+`, "gu");
const WWW_URL = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}.@-])www\\.${URL_BODY}+`, "giu");
const IPV6 = /\[[0-9a-f.]*:[0-9a-f.]*:[0-9a-f:.]*\]/giu;
const IPV4 = /(?<![\p{N}.])(?:\d{1,3}\.){3}\d{1,3}(?![\p{N}]|\.\d)/gu;
const BRACKET_DOT = "\\s*(?:\\[\\s*\\.\\s*\\]|\\(\\s*\\.\\s*\\)|\\{\\s*\\.\\s*\\})\\s*";
const BRACKETED = new RegExp(
  `${LABEL}(?:(?:${BRACKET_DOT}|\\.)${LABEL})*${BRACKET_DOT}${LABEL}(?:(?:${BRACKET_DOT}|\\.)${LABEL})*`,
  "gu"
);
// a word between spaces, or in brackets: "idopontban" or "anecdote" hold the word, not the separator
const SPELLED_DOT = "(?:\\s+(?:pont|dot)\\s+|\\s*[\\[({]\\s*(?:pont|dot)\\s*[\\])}]\\s*)";
const SPELLED = new RegExp(`${LABEL}(?:${SPELLED_DOT}${LABEL})+`, "giu");
const BARE = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_.\\/-])(?:${LABEL}\\.)+${LABEL}(?![\\p{L}\\p{M}\\p{N}_]|\\.[\\p{L}\\p{M}\\p{N}])(?::\\d{1,5})?(\\/${URL_BODY}*)?`,
  "gu"
);

/** The last label is a real TLD (a case ending after a hyphen aside). */
const onRealTld = (host: string) => IANA_TLDS.has(host.split(".").pop() ?? "");

/**
 * Every address in the text, in the order of the passes (plan 5.1). Each pass
 * blanks what it took, so a URL is not counted again as a bare domain.
 */
export function findLinks(text: string): FoundLink[] {
  let rest = text;
  const found: FoundLink[] = [];
  // `group` is the first capture group (only BARE has one: the path), "" when there is none
  const take = (pattern: RegExp, read: (whole: string, group: string) => FoundLink | null) => {
    rest = rest.replace(pattern, (whole: string, ...more: unknown[]) => {
      const link = read(whole, typeof more[0] === "string" ? more[0] : "");
      if (!link) return whole;
      found.push(link);
      return " ".repeat(whole.length);
    });
  };

  take(SCHEME_URL, (whole) => fromAuthority(whole));
  take(SCHEMELESS_URL, (whole) => fromAuthority(`http:${whole}`));
  take(WWW_URL, (whole) => fromAuthority(`http://${whole}`));
  take(IPV6, (whole) => ({ host: whole.slice(1, -1).toLowerCase(), ip: true, path: "" }));
  take(IPV4, (whole) => (isIPv4(whole) ? { host: whole, ip: true, path: "" } : null));
  take(BRACKETED, (whole) => ({
    host: normalizeHost(whole.replace(new RegExp(BRACKET_DOT, "gu"), ".")),
    ip: false,
    path: ""
  }));
  take(SPELLED, (whole) => {
    const labels = whole.split(new RegExp(SPELLED_DOT, "iu"));
    if (SPELLED_SEPARATOR_STOPWORDS.has(fold(labels[labels.length - 1] ?? ""))) return null;
    const host = normalizeHost(labels.join("."));
    return onRealTld(host) ? { host, ip: false, path: "" } : null;
  });
  take(BARE, (whole, path) => {
    const host = normalizeHost(whole.replace(/(?::\d{1,5})?(?:\/.*)?$/su, ""));
    const tld = host.split(".").pop() ?? "";
    if (!IANA_TLDS.has(tld) || FILE_EXTENSION_TLDS.has(tld)) return null;
    return { host, ip: false, path };
  });
  return found;
}

/** Our domain or a subdomain of it, on a label boundary. An IP never is. */
export const isOwnHost = (link: FoundLink) =>
  !link.ip && (link.host === OWN_DOMAIN || link.host.endsWith(`.${OWN_DOMAIN}`));

/** A product-page shaped path on our domain (plan 5.4): a model-invented product page would look like this. */
const PRODUCT_PATH = /^\/(?:termek|spd)\//i;

/** The brands of the hits the answer had in front of it (the projection carries `brand`). */
export function hitBrandsOf(outcome: ProductSearchOutcome): Set<string> {
  const brands = new Set<string>();
  if (!outcome.ok) return brands;
  const hits = (outcome.result as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return brands;
  for (const hit of hits) {
    const brand = (hit as { brand?: unknown })?.brand;
    if (typeof brand === "string" && brand.trim() !== "") brands.add(fold(brand.trim()));
  }
  return brands;
}

export type LinkViolationReason = "EXTERNAL_LINK" | "EXCEPTION_WITHOUT_STORED_SOURCE";

export interface LinkGuardInput {
  answer: string;
  userMessage: string;
  outcome: ProductSearchOutcome;
  sources: readonly StoredLinkSource[];
}

export interface LinkGuardResult {
  ok: boolean;
  /** The first violation's reason; null when nothing violated. */
  reason: LinkViolationReason | null;
  /** The violating hosts, unique, at most ten: the host only, never the URL. */
  hosts: string[];
  /** External links one of the three exceptions let through. */
  allowedByException: number;
  ownLinks: number;
  ownProductPathLinks: number;
}

/**
 * THE THREE EXCEPTIONS ARE THREE INDEPENDENT CONDITIONS (plan section 4), each
 * over a host on the stored list:
 *  - K1: the user asked for a link or a source; any category.
 *  - K2: a MANUFACTURER_DOCUMENT whose brand is the brand of one of the hits.
 *  - K3: an AUTHORITY host, and the user's question is on a legal, authority,
 *    warranty or safety topic.
 */
function allowedBy(
  source: StoredLinkSource,
  asksForLink: boolean,
  authorityTopic: boolean,
  hitBrands: Set<string>
): boolean {
  if (asksForLink) return true;
  if (
    source.category === "MANUFACTURER_DOCUMENT" &&
    source.brand !== null &&
    hitBrands.has(fold(source.brand.trim()))
  )
    return true;
  return source.category === "AUTHORITY" && authorityTopic;
}

export function guardAnswerLinks(input: LinkGuardInput): LinkGuardResult {
  const message = fold(input.userMessage);
  const asksForLink = LINK_REQUEST.test(message);
  const authorityTopic = AUTHORITY_TOPIC.test(message);
  const hitBrands = hitBrandsOf(input.outcome);
  const result: LinkGuardResult = {
    ok: true,
    reason: null,
    hosts: [],
    allowedByException: 0,
    ownLinks: 0,
    ownProductPathLinks: 0
  };
  for (const link of findLinks(input.answer)) {
    if (isOwnHost(link)) {
      result.ownLinks++;
      if (PRODUCT_PATH.test(link.path)) result.ownProductPathLinks++;
      continue;
    }
    const source = link.ip
      ? undefined
      : input.sources.find((s) => normalizeHost(s.host) === link.host);
    if (source && allowedBy(source, asksForLink, authorityTopic, hitBrands)) {
      result.allowedByException++;
      continue;
    }
    result.ok = false;
    result.reason ??=
      !source && (asksForLink || authorityTopic)
        ? "EXCEPTION_WITHOUT_STORED_SOURCE"
        : "EXTERNAL_LINK";
    if (!result.hosts.includes(link.host) && result.hosts.length < 10) result.hosts.push(link.host);
  }
  return result;
}
