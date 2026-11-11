/**
 * THE MODEL DOES NOT SEE A CUSTOMER'S E-MAIL ADDRESS OR TELEPHONE NUMBER (Acropora OS card f5b8f7ba, slice 4c; plan
 * `exchange-out/ai-eloszures-4-szelet-terv-2026-11-11.md` section 2/b, matrix S11; barracuda's review of the plan, point 2; acrobot
 * 46739: also with the contact request switched off).
 *
 * WHY: a customer may type a telephone number or an address into the chat, and until now the whole history, those lines included,
 * went to the model provider on every turn. The model never needs a contact to answer a question about corals, and what it does not
 * receive cannot leak. The masking happens IN MEMORY, on the model's input only: the stored messages are not changed here (their
 * fate is the retention job's, and, after a hand-over, the contact request's, slices 4b and 4c).
 *
 * THE PATTERNS ARE DELIBERATELY NARROW (barracuda, point 3): an order number, a part number, an invoice number, a date, a price, a
 * water value or an ICP result must NOT be taken for a telephone number, because a masked order number ("a rendelésszámom
 * [elérhetőség]") would break an answer that has nothing to do with contact data. So a telephone number is only a HUNGARIAN
 * one with its prefix (`+36`, `0036` or `06`) followed by eight or nine digits (the area code and the subscriber number, with the
 * usual spaces, dashes, dots, slashes or brackets between them), standing on its own (no digit right before or after it). An e-mail
 * address is the usual `local@domain.tld` shape. What these patterns do not catch (a foreign number, a number without its prefix)
 * stays in the text: the mask is a floor, not a promise of completeness.
 */
export const CONTACT_PLACEHOLDER = "[elérhetőség]";

/** Exactly `false` turns the masking off; anything else, including empty, leaves it ON (a privacy floor is not an opt-in feature). */
export const MASK_CONTACTS_ENV = "AI_CHAT_MASK_CONTACTS";

export const maskContactsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[MASK_CONTACTS_ENV] !== "false";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** The separators a person puts inside a telephone number. */
const SEP = String.raw`[\s.\-/()]*`;

/**
 * `+36` / `0036` / `06`, then eight or nine digits with separators between them, with no digit before the prefix and no digit after
 * the last number (a lookbehind and a lookahead on digits, so a longer digit string is no telephone number).
 */
const PHONE = new RegExp(
  String.raw`(?<![\d+])(?:\+36|0036|06)${SEP}(?:\d${SEP}){7,8}\d(?!\d)`,
  "g"
);

export interface MaskedText {
  text: string;
  /** How many contacts were replaced (a number only: the log may hold it, never the text). */
  masked: number;
}

export function maskContacts(text: string): MaskedText {
  let masked = 0;
  const replace = () => {
    masked += 1;
    return CONTACT_PLACEHOLDER;
  };
  // Addresses first: an address may contain a digit run that the telephone pattern would otherwise start on.
  const withoutEmail = text.replace(EMAIL, replace);
  const withoutPhone = withoutEmail.replace(PHONE, replace);
  return { text: withoutPhone, masked };
}

export type ContactChannel = "EMAIL" | "PHONE";

export interface FoundContact {
  channel: ContactChannel;
  /** The value exactly as the customer typed it, trimmed. */
  value: string;
}

/**
 * THE CONTACT IN A REPLY TO THE COLLEAGUE OFFER (card f5b8f7ba, slice 4c): the FIRST e-mail address or Hungarian telephone number in
 * the text, by position, with the same narrow patterns the mask uses (so what the mask would hide is what a request can carry).
 * ONE request per message: a second contact in the same text is not handed over. Null when there is none. The value is returned,
 * never logged: the caller may log the channel only.
 */
export function findContact(text: string): FoundContact | null {
  const email = new RegExp(EMAIL.source).exec(text);
  const phone = new RegExp(PHONE.source).exec(text);
  const candidates: Array<{ index: number; contact: FoundContact }> = [];
  if (email)
    candidates.push({ index: email.index, contact: { channel: "EMAIL", value: email[0].trim() } });
  if (phone)
    candidates.push({ index: phone.index, contact: { channel: "PHONE", value: phone[0].trim() } });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0].contact;
}
