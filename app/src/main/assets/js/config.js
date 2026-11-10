/**
 * Which build these PAGES are from, which is not always the same question as
 * which build the app is from: the pages are cached, the app is not. Shown
 * beside the app's own version in Data & sync, so the two disagreeing is
 * something you can see rather than something you have to deduce from a bug
 * that will not die.
 */
export const ASSET_BUILD = '6.44';

// Who you are, across accounts — held at runtime, NOT written here.
//
// This file used to contain a real phone number, two real account numbers and a
// family member's number. That was fine while it was a file on one PC. It stops
// being fine the moment the code is hosted anywhere so a phone can install it:
// source gets published, and those identifiers would go with it.
//
// So the values now live in your browser's own storage and are edited in the
// Settings panel. The code ships knowing nothing about you.
//
// `configure()` fills these in at startup. The exports are live bindings, so every
// module that imported them sees the update without re-importing.

export const ME = { phones: [], accounts: [], name: '' };
export let PEOPLE = [];

// A send to a person of this much or less is almost always food — the sellers who
// take payment by phone rather than a till. Above it the app refuses to guess and
// leaves it Uncategorised for you to assign.
//
// This is the one guess the app still makes, and it's narrow on purpose: it catches
// the long tail of small sends, not the money that actually matters.
export let SMALL_SEND_LIMIT = 200;

/**
 * How far back the app reads, as a number of months before today, or 0 for
 * everything. Everything on file stays on file - this is how much of it is
 * loaded into a screen.
 *
 * The default is five months, which from the autumn of 2026 reaches back to
 * June. A phone re-reading four years of messages every time a figure changes
 * is the whole of the lag.
 */
/**
 * The day a budget month starts, because that is the day the money arrives.
 *
 * One number, in one place, used by everything that has an opinion about which
 * month a transaction belongs to. It used to be inferred per-report from
 * detected pay runs, and two reports could infer differently.
 */
export const CYCLE_DAY = 28;

export const DEFAULT_WINDOW_MONTHS = 5;

/**
 * The fixed floor Jose asked for: June 2026, and everything after it.
 *
 * A rolling "last five months" would have reached the same date in October and
 * then walked away from it - by January it would start in August, and the first
 * half of the year would quietly leave the app. A date stays where it is put.
 * It does mean the window grows by a month every month; measured on 10,000
 * transactions, two years of them costs 56ms a render against 34ms for five
 * months, so it has years of room before that matters.
 */
export const DEFAULT_WINDOW_FROM = '2026-06-01';

export const DEFAULT_SETTINGS = {
  windowFrom: DEFAULT_WINDOW_FROM,
  windowMonths: DEFAULT_WINDOW_MONTHS, name: '', phones: [], accounts: [], people: [], smallSendLimit: 200 };

export function configure(s = {}) {
  ME.phones = (s.phones || []).map(norm).filter(Boolean);
  ME.accounts = (s.accounts || []).map((a) => String(a).trim()).filter(Boolean);
  ME.name = String(s.name || '').trim();
  PEOPLE = (s.people || []).filter((p) => p && p.number && p.name);
  SMALL_SEND_LIMIT = Number.isFinite(+s.smallSendLimit) ? +s.smallSendLimit : 200;
}

/** 07… and 2547… are the same line. Store one form so comparisons are simple. */
export function norm(n) {
  const s = String(n || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  return s.replace(/^0/, '254');
}

/**
 * True if a statement description refers to one of your own phones/accounts.
 *
 * This is what makes "internal transfer" a fact rather than a guess. A bank row
 * reading "IBKG MPESA PAY TO <your number>" is you topping up your own wallet — the
 * same movement M-PESA also records, so counting both would double it. A row naming
 * someone else's number is real spending. Only this list tells the two apart, which
 * is why an empty Settings panel quietly breaks the distinction.
 */
export function isSelf(text) {
  const s = String(text || '');
  if (!ME.phones.length && !ME.accounts.length) return false;
  return [...ME.phones, ...ME.accounts].some((id) => id && s.includes(id));
}

/** Has the user told us who they are yet? */
/**
 * True when a name in a message is HIS name.
 *
 * A bank writes the sender's full name and nothing else that distinguishes his
 * own transfer from someone else's payment. Matched on a word boundary and only
 * from three letters up: "JOSE" is inside "JOSEPHAT", and filing a relative's
 * payment as an internal transfer would quietly delete it from the totals.
 */
export function isMyName(text) {
  if (!ME.name || ME.name.length < 3) return false;
  const safe = ME.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${safe}\\b`, 'i').test(String(text || ''));
}

export function isConfigured() {
  return ME.phones.length > 0 || ME.accounts.length > 0;
}
