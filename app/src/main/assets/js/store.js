// Persistence. Everything lives in this browser's localStorage — no server, no upload.
// Transactions are a map keyed by id (receipt code), which makes dedupe free: importing
// the same transaction twice, from SMS and again from a statement, overwrites rather
// than duplicates.

import { nameBareNumbers } from './identify.js';
import { DEFAULT_PAYABLES, SEED_VERSION } from './payables.js';
import { DEFAULT_BUDGETS, BUDGET_SEED_VERSION } from './budgets.js';
import { DEFAULT_SETTINGS, configure } from './config.js';

const KEY = 'mpesa-tracker.v1';

const empty = () => ({
  transactions: {},
  userRules: [],
  nameRules: [],
  customCategories: [],
  overrides: {},
  // txnId -> [{category, amount, month?}, ...] that sum to the transaction's amount.
  // One movement, split across several categories (see setSplit). A part's optional
  // `month` (YYYY-MM) counts that slice toward a chosen budget month instead of the
  // transaction's own date — a househelp salary paid 30 Jun that's really July's.
  splits: {},
  // txnId -> 'YYYY-MM': count a WHOLE (un-split) transaction toward a chosen budget
  // month instead of its date. Budgeting only; the statement date never moves.
  budgetMonths: {},
  payables: null, // null = never initialised; [] = user deleted them all
  payablesSeed: 0, // which SEED_VERSION the stored payables came from
  payableFixes: 0, // left from a one-off correction round that has been removed
  budgets: null,
  budgetSeed: 0, // which BUDGET_SEED_VERSION the stored budget LINES came from
  // refundTxnId -> the spend it pays back
  refundLinks: {},
  // Your phone numbers, account numbers and known people. Deliberately not in the
  // source: see js/config.js.
  settings: null,
  seeded: false,
  // Shopping receipts pasted over from the Basket Budget phone app, and
  // receiptId -> txnId for the statement line each one paid for.
  receipts: [],
  receiptLinks: {},
  // receiptId -> the id of the cash run it created. A receipt you paid in cash
  // has no payment to match, so it claims against a withdrawal instead.
  receiptCash: {},
  rawDropped: 0, // the one-off that freed the stored SMS text
  diningFolded: 0, // the one-off that merged Dining & Takeout into Entertainment
  // category -> colour slot on the ring. Remembered so a category keeps its
  // colour when the ranking changes; see chartSlots().
  catSlots: {},
  // Itemised cash: {id, date, category, amount, items:[{name, amount}], note}.
  // NOT transactions. The money already counted when it was withdrawn, so these
  // only say what it went on - see js/cash.js for why that distinction matters.
  cashRuns: [],
  // Cash that came into your hand without leaving an account - a gift, change,
  // a refund in notes: {id, date, amount, note}. Not transactions and not
  // income; they only say where cash the app never saw drawn came from.
  cashIn: [],
  // LENDER -> the day it last told us a loan of its was finished. Not money, so
  // not a transaction; it is what stops a settled loan being predicted forever.
  settlements: {},
});

let state = empty();

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...empty(), ...JSON.parse(raw) };
  } catch (err) {
    console.error('Could not read saved data; starting empty.', err);
    state = empty();
  }
  migrate();
  dropRawFromSms();
  foldDiningIntoEntertainment();
  return state;
}

/**
 * When there was only one bank it was called "bank". Now each institution has its
 * own id, so those rows would sit under a name nothing produces any more — orphaned
 * from the account filter and from the labels.
 */
function migrate() {
  let changed = 0;
  for (const t of Object.values(state.transactions)) {
    if (t.accountSource === 'bank') {
      t.accountSource = 'stanchart';
      changed++;
    }
    // An older parser left the Fuliza funding glued onto the counterparty of a
    // Fuliza-funded send or purchase — "Fuliza MPesa to - 2547…NAME", "Fuliza
    // M-Pesa Online to 6727013 - Java Lunga Lunga". The /Fuliza/ debt rule then
    // swallowed it into Loans & Credit, so real spending dropped out of the budget.
    // The parser strips it now, but a statement row already stored is never
    // re-parsed (dedupe keeps the first), so clean the stored copies once. The credit
    // line is how it was funded, not what it was spent on.
    if (typeof t.counterparty === 'string') {
      const m = t.counterparty.match(/^Fuliza\s+M-?Pesa\s+(?:Online\s+)?to\s*-?\s*(.+)$/i);
      if (m) {
        t.counterparty = m[1].trim();
        changed++;
      }
      // "KCB M-PESA Withdraw" rows were named "Agent withdrawal" by an older parser, so
      // money arriving from his own KCB M-PESA account read as an agent cash
      // withdrawal — and, being inbound, was counted as income. Rename the stored rows
      // once; the parser gets it right from here on.
      if (/^Agent withdrawal$/i.test(t.counterparty) && /KCB\s*M-?PESA\s*Withdraw/i.test(t.raw || '')) {
        t.counterparty = 'KCB M-PESA Withdrawal';
        changed++;
      }
    }
  }
  if (changed) save();
}

/**
 * Bumped by every write. It is what lets the page tell "the data changed" from
 * "you picked a different time range", so categorising ten thousand rows through
 * sixty rules happens when something actually moved, not on every click.
 */
let rev = 0;
export function revision() {
  return rev;
}

/** Set when a save failed, so the page can say so where it cannot be missed. */
export let saveFailed = null;

export function save() {
  rev++;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    saveFailed = null;
  } catch (err) {
    // Quota is the realistic failure, and it is quiet: the app keeps working
    // from memory and loses everything when it closes. alert() was the old
    // answer and a WebView swallows alerts, so this is held for the page to
    // show instead.
    saveFailed = err && err.message ? err.message : 'storage is full';
    console.error('Could not save', err);
  }
}

export function getState() {
  return state;
}

/**
 * Merge transactions in, deduping by id.
 * @returns {{added: number, duplicate: number}}
 */
export function addTransactions(txns) {
  let added = 0;
  let duplicate = 0;
  for (const t of txns) {
    if (state.transactions[t.id]) {
      duplicate++;
      // A statement is authoritative over an SMS for the same receipt.
      if (t.source === 'statement' && state.transactions[t.id].source !== 'statement') {
        state.transactions[t.id] = t;
      }
      continue;
    }
    state.transactions[t.id] = t;
    added++;
  }
  // Re-run after every import, not just once: the bank statement may arrive before
  // the M-PESA one that supplies the names, and either order must work.
  const named = resolveIdentities();
  save();
  return { added, duplicate, named };
}

/** Put names to the bank's bare phone numbers using M-PESA's masked ones. */
export function resolveIdentities() {
  return nameBareNumbers(Object.values(state.transactions));
}

export function allTransactions() {
  return Object.values(state.transactions).sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Recategorising one transaction makes a rule for that person or merchant, so every
 * other transaction of theirs follows — past and future.
 *
 * The rule keys on the NAME, not the exact counterparty string: the same person
 * arrives as "07******156 PAUL KAMUYU" in an SMS and "2547******156 PAUL KAMUYU" in
 * a statement, so an exact-string rule would catch one and quietly miss the other.
 *
 * @param nameFor  extracts the human part of a counterparty (rules.personName)
 */
export function setCategory(id, category, applyToAll, nameFor = (s) => s) {
  const txn = state.transactions[id];
  if (!txn) return { applied: 1, name: null };
  state.overrides[id] = category;
  // Choosing one category is the opposite of splitting across several — drop any
  // split, or it would keep winning in every total (categoryParts reads splits).
  if (state.splits[id]) delete state.splits[id];

  if (!applyToAll || !txn.counterparty) {
    save();
    return { applied: 1, name: null };
  }

  const name = nameFor(txn.counterparty);
  // A name we can't isolate (odd counterparty shape) falls back to an exact rule
  // rather than matching a fragment that might catch unrelated transactions.
  if (!name || name === txn.counterparty) {
    state.userRules = state.userRules.filter(
      (r) => r.counterparty.toLowerCase() !== txn.counterparty.toLowerCase()
    );
    state.userRules.push({ counterparty: txn.counterparty, category });
    save();
    return { applied: countMatching(txn.counterparty), name: txn.counterparty };
  }

  // Drop the one-off override and any stale exact rule for this person — both
  // outrank the name rule we're about to make, and both are invisible in the UI.
  delete state.overrides[id];
  purgeConflicts(name);
  state.nameRules = state.nameRules.filter((r) => r.match.toLowerCase() !== name.toLowerCase());
  state.nameRules.push({ match: name, category });
  save();
  return { applied: countMatching(name), name };
}

/**
 * Split ONE transaction across several categories — "I sent one amount to one person, but
 * 8,000 was the househelp and 3,000 groceries". Stored per transaction id; the parts
 * must add up to the transaction's amount (bar a shilling of rounding), so a split
 * neither invents nor loses money. It supersedes the single category everywhere
 * spending is totalled — budgets, the category chart, the monthly report — while the
 * transaction stays ONE row on the statement, the balance and reconciliation, because
 * it was one movement. Setting a plain category (setCategory) clears it.
 */
export function setSplit(id, parts) {
  const txn = state.transactions[id];
  if (!txn) return { ok: false, error: 'No such transaction.' };
  const clean = (parts || [])
    .map((p) => {
      const part = { category: String(p.category || '').trim(), amount: Math.round((Number(p.amount) || 0) * 100) / 100 };
      if (p.month && /^\d{4}-\d{2}$/.test(p.month)) part.month = p.month; // per-part budget month (optional)
      return part;
    })
    .filter((p) => p.category && p.amount > 0);
  if (clean.length < 2) return { ok: false, error: 'A split needs at least two parts with an amount.' };
  const sum = clean.reduce((a, p) => a + p.amount, 0);
  if (Math.abs(sum - txn.amount) > 1) {
    return {
      ok: false,
      error: `The parts add up to ${Math.round(sum).toLocaleString()}, but the transaction is ${Math.round(txn.amount).toLocaleString()}.`,
    };
  }
  state.splits[id] = clean;
  delete state.overrides[id]; // a split and a single category are two answers to one question
  save();
  return { ok: true };
}

/** Undo a split — the transaction goes back to its single computed/assigned category. */
export function clearSplit(id) {
  if (state.splits[id]) {
    delete state.splits[id];
    save();
  }
}

export function splitFor(id) {
  return state.splits[id] || null;
}

export function budgetMonthFor(id) {
  return state.budgetMonths[id] || null;
}

/**
 * Every month something has been deliberately assigned to. The month list is otherwise
 * built from transaction dates, so a pay received on 28 July and assigned to August
 * would live in a month you couldn't select — and would silently vanish.
 */
export function assignedBudgetMonths() {
  const out = new Set(Object.values(state.budgetMonths));
  for (const parts of Object.values(state.splits)) {
    for (const p of parts) if (p.month) out.add(p.month);
  }
  return [...out];
}

/**
 * Count a payment toward a chosen budget month — pull an end-of-June househelp salary
 * into July's budget where it belongs. Driven from a budget LINE, so `categories` says
 * which part of a split to move (the Household Staff slice, not the groceries one).
 *
 *   month = 'YYYY-MM'  → assign to that month
 *   month = null       → clear the assignment (back to the transaction's own date)
 *
 * The statement date never changes — this is budgeting only.
 */
export function assignBudgetMonth(id, categories, month) {
  const txn = state.transactions[id];
  if (!txn) return { ok: false, error: 'No such transaction.' };
  if (month && !/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'Bad month.' };
  const cats = new Set(categories || []);
  const split = state.splits[id];

  if (split && split.length) {
    // Move only the slices that belong to this budget line; leave the rest on their
    // own month. (An empty category set moves every slice.)
    let touched = 0;
    state.splits[id] = split.map((p) => {
      if (cats.size && !cats.has(p.category)) return p;
      touched++;
      const { month: _drop, ...rest } = p;
      return month ? { ...rest, month } : rest;
    });
    if (!touched) return { ok: false, error: 'This payment has no part on that budget line.' };
  } else if (month) {
    state.budgetMonths[id] = month;
  } else {
    delete state.budgetMonths[id];
  }
  save();
  return { ok: true };
}

// Payables seed once from the wealth-tracker sheet, then belong to the user. `null`
// means never initialised — an empty array means they deliberately removed them all,
// and re-seeding over that would be infuriating.
export function payables() {
  if (state.payables === null) {
    state.payables = DEFAULT_PAYABLES.map((p) => ({ ...p }));
    state.payablesSeed = SEED_VERSION;
    save();
    return state.payables;
  }

  // Never let an empty default list wipe real balances. DEFAULT_PAYABLES is empty by
  // design now (debts don't belong in shipped code), so a re-seed would silently
  // delete everything the user has.
  if (!DEFAULT_PAYABLES.length) return state.payables;

  // Corrected figures must reach an install that already seeded the old ones —
  // otherwise a balance we now know is wrong sits there forever. Re-seed on a
  // version bump, but carry across anything recorded by hand, and leave payables
  // the user added themselves alone.
  if ((state.payablesSeed || 0) < SEED_VERSION) {
    const manual = new Map(state.payables.map((p) => [p.id, p.manualPaid || 0]));
    const custom = state.payables.filter((p) => String(p.id).startsWith('custom-'));
    state.payables = [
      ...DEFAULT_PAYABLES.map((p) => ({
        ...p,
        manualPaid: manual.has(p.id) ? Math.max(p.manualPaid || 0, manual.get(p.id)) : p.manualPaid || 0,
      })),
      ...custom,
    ];
    state.payablesSeed = SEED_VERSION;
    save();
  }
  return state.payables;
}

/**
 * Point a refund at the spend it pays back.
 *
 * A refund isn't income — it's money you'd already spent coming home. Linked to its
 * original, it reduces THAT category rather than inflating what you earned: 3,000
 * paid and 2,500 returned cost you 500, and that's the only figure that's true.
 */
export function linkRefund(refundId, spendId) {
  const r = state.transactions[refundId];
  const s = state.transactions[spendId];
  if (!r || !s) return { ok: false, error: 'Could not link those.' };
  if (r.direction !== 'In') return { ok: false, error: 'A refund has to be money coming in.' };
  if (s.direction !== 'Out') return { ok: false, error: 'It has to offset money going out.' };
  state.refundLinks[refundId] = spendId;
  save();
  return { ok: true, refund: r, spend: s };
}

export function unlinkRefund(refundId) {
  delete state.refundLinks[refundId];
  save();
}

/** Candidate spends for a refund: money out, ranked by how well they fit. */
export function offsetCandidates(refundId, { query = '', limit = 40 } = {}) {
  const r = state.transactions[refundId];
  if (!r) return [];
  const q = query.trim().toLowerCase();
  const rt = r.date ? +new Date(r.date) : 0;

  return Object.values(state.transactions)
    .filter((t) => t.direction === 'Out')
    .filter((t) => !q || `${t.counterparty || ''} ${t.receipt || ''} ${t.raw || ''}`.toLowerCase().includes(q))
    .sort((a, b) => {
      // A refund follows its spend and is usually close in size. Prefer spends just
      // before it, of a similar amount.
      const score = (t) => {
        const dt = rt - (t.date ? +new Date(t.date) : 0);
        const before = dt >= 0 ? 0 : 1e12; // after the refund: implausible
        return before + Math.abs(t.amount - r.amount) + dt / 1e7;
      };
      return score(a) - score(b);
    })
    .slice(0, limit);
}

export function settings() {
  // Merged over the defaults, not just created from them. An install made before
  // a setting existed has no key for it, and reading that absence as "0" is how a
  // new "how far back to read" arrived switched off on the one device that needed
  // it. Anything stored still wins; only the gaps are filled.
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  return state.settings;
}

/** Push the stored identifiers into config's live bindings. */
export function applySettings() {
  configure(settings());
}

export function saveSettings(patch) {
  state.settings = { ...settings(), ...patch };
  save();
  applySettings();
  // Bank rows are named using the people list, so a new entry can resolve numbers
  // that were bare until now.
  resolveIdentities();
  save();
  return state.settings;
}

export function budgets() {
  if (state.budgets === null) {
    state.budgets = DEFAULT_BUDGETS.map((b) => ({ ...b, categories: [...b.categories] }));
    state.budgetSeed = BUDGET_SEED_VERSION;
    save();
    return state.budgets;
  }

  // A budget LINE (its label and which categories it covers) is code-owned structure,
  // not user data — only the amount is yours. So when the seed's mappings change (a
  // category split out, a new line added), an install that already stored the old
  // lines must pick up the new ones, or a line points at nothing forever — which is
  // exactly what the empty "Electricity" line did. On a version bump, rebuild the
  // lines from the seed, carry every stored amount across by id, and leave lines the
  // user added themselves untouched.
  if ((state.budgetSeed || 0) < BUDGET_SEED_VERSION) {
    const amount = new Map(state.budgets.map((b) => [b.id, b.amount]));
    const seededIds = new Set(DEFAULT_BUDGETS.map((b) => b.id));
    const custom = state.budgets.filter((b) => !seededIds.has(b.id));
    state.budgets = [
      ...DEFAULT_BUDGETS.map((b) => ({
        ...b,
        categories: [...b.categories],
        amount: amount.has(b.id) ? amount.get(b.id) : b.amount,
      })),
      ...custom,
    ];
    state.budgetSeed = BUDGET_SEED_VERSION;
    save();
  }
  return state.budgets;
}

export function setBudget(id, amount) {
  const b = budgets().find((x) => x.id === id);
  if (!b) return;
  b.amount = Math.max(0, Number(amount) || 0);
  save();
}

export function setBudgetCategories(id, categories) {
  const b = budgets().find((x) => x.id === id);
  if (!b) return;
  b.categories = categories;
  save();
}

/** Record a payment that no statement can see — plot instalments, cash, cheques. */
export function recordManualPayment(id, amount) {
  const p = payables().find((x) => x.id === id);
  if (!p) return { ok: false, error: 'No such item.' };
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return { ok: false, error: 'Enter an amount.' };
  p.manualPaid = Math.max(0, (p.manualPaid || 0) + n);
  save();
  return { ok: true, manualPaid: p.manualPaid };
}

/** Point an existing transaction at a debt — better than retyping the amount. */
export function linkPayment(payableId, txnId) {
  const p = payables().find((x) => x.id === payableId);
  if (!p || !state.transactions[txnId]) return { ok: false, error: 'Could not link that.' };
  p.linkedIds = p.linkedIds || [];
  if (p.linkedIds.includes(txnId)) return { ok: false, error: 'Already linked.' };
  p.linkedIds.push(txnId);
  save();
  return { ok: true, txn: state.transactions[txnId] };
}

export function unlinkPayment(payableId, txnId) {
  const p = payables().find((x) => x.id === payableId);
  if (!p) return;
  p.linkedIds = (p.linkedIds || []).filter((i) => i !== txnId);
  save();
}

/**
 * Transactions worth offering as a payment for this debt: money out, not already
 * linked somewhere else. Ranked by how well they fit — a debt is usually settled by
 * a payment for roughly its amount, so those float to the top.
 */
export function paymentCandidates(payableId, { query = '', owed = 0, limit = 40 } = {}) {
  const q = query.trim().toLowerCase();
  const takenElsewhere = new Set(
    payables()
      .filter((p) => p.id !== payableId)
      .flatMap((p) => p.linkedIds || [])
  );

  return Object.values(state.transactions)
    .filter((t) => t.direction === 'Out' && !takenElsewhere.has(t.id))
    .filter((t) => !q || `${t.counterparty || ''} ${t.receipt || ''} ${t.raw || ''}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (owed > 0) {
        const da = Math.abs(a.amount - owed);
        const db = Math.abs(b.amount - owed);
        // Exact-ish amounts first; otherwise most recent.
        if (da < owed * 0.02 || db < owed * 0.02) return da - db;
      }
      return a.date < b.date ? 1 : -1;
    })
    .slice(0, limit);
}

export function updatePayable(id, patch) {
  const p = payables().find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  save();
}

/**
 * Transactions with no date at all.
 *
 * They cannot be placed in a month, a cycle, a chart or a trend, so every screen
 * that is organised by time either ignores them or is distorted by them. They
 * are always a parsing accident, never something anyone entered.
 */
/** Remembers a lender saying a loan is done. The latest word wins. */
export function noteSettlements(list) {
  let changed = false;
  for (const s of list || []) {
    if (!s || !s.lender || !s.date) continue;
    if (!state.settlements[s.lender] || state.settlements[s.lender] < s.date) {
      state.settlements[s.lender] = s.date;
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

export function settlements() {
  return state.settlements || {};
}

/**
 * Throws away the stored copy of each SMS, once.
 *
 * The message text was kept on every transaction and is the larger half of the
 * record: the parsed fields are about 180 bytes, the message another 200, and
 * most of that 200 is Safaricom's boilerplate about daily limits and paybill
 * shortcuts. It is what pushed the whole store past the 5MB an origin gets.
 *
 * The rows IMPORTED FROM STATEMENTS keep theirs - there are far fewer of them
 * and the reconciler reads bank references out of the text. And a message can
 * always be read again; a save that silently failed could not be.
 */
function dropRawFromSms() {
  if (state.rawDropped) return;
  let n = 0;
  for (const t of Object.values(state.transactions)) {
    if (t.raw && (t.source === 'sms' || !t.source)) {
      delete t.raw;
      n++;
    }
  }
  state.rawDropped = 1;
  save();
  if (n) console.info(`Freed the stored message text from ${n} transactions.`);
}

/**
 * "Dining & Takeout" and "Entertainment" were one thing pretending to be two.
 *
 * Removing a category from the registry is not enough: every rule, override and
 * split still pointing at the old name would quietly stop matching anything, and
 * the money under it would read as uncategorised again. So the name is rewritten
 * wherever it was stored, once.
 */
function foldDiningIntoEntertainment() {
  if (state.diningFolded) return;
  const OLD = 'Dining & Takeout';
  const NEW = 'Entertainment';
  let n = 0;

  for (const [id, c] of Object.entries(state.overrides || {})) {
    if (c === OLD) {
      state.overrides[id] = NEW;
      n++;
    }
  }
  for (const r of state.userRules || []) if (r.category === OLD) ((r.category = NEW), n++);
  for (const r of state.nameRules || []) if (r.category === OLD) ((r.category = NEW), n++);
  for (const parts of Object.values(state.splits || {})) {
    for (const p of parts) if (p.category === OLD) ((p.category = NEW), n++);
  }
  state.customCategories = (state.customCategories || []).filter((c) => c.name !== OLD);
  for (const b of state.budgets || []) {
    if (!Array.isArray(b.categories)) continue;
    if (!b.categories.includes(OLD)) continue;
    b.categories = [...new Set(b.categories.map((c) => (c === OLD ? NEW : c)))];
    n++;
  }

  state.diningFolded = 1;
  save();
  if (n) console.info(`Moved ${n} things from “${OLD}” to “${NEW}”.`);
}

/**
 * Which of the eight chart colours each category gets.
 *
 * Assigned per CATEGORY, not per rank, so Groceries stays the same colour when
 * it slips from second place to fourth - a chart that repaints itself every
 * month teaches you nothing about any of them. A category keeps its remembered
 * slot whenever that slot is free, and anything new takes the lowest one left,
 * so the set on screen is always eight distinct colours.
 *
 * @param {string[]} categories  what is about to be drawn, biggest first
 * @returns {Record<string, number>} category -> 0..7
 */
export function chartSlots(categories) {
  if (!state.catSlots) state.catSlots = {};
  const want = state.catSlots;
  const out = {};
  const taken = new Set();

  for (const c of categories) {
    const slot = want[c];
    if (slot != null && !taken.has(slot)) {
      out[c] = slot;
      taken.add(slot);
    }
  }
  for (const c of categories) {
    if (out[c] != null) continue;
    let slot = 0;
    while (taken.has(slot) && slot < 8) slot++;
    out[c] = slot % 8;
    taken.add(out[c]);
  }

  // Only write when something actually changed: this runs on every render.
  let moved = false;
  for (const [c, slot] of Object.entries(out)) {
    if (want[c] !== slot) {
      want[c] = slot;
      moved = true;
    }
  }
  if (moved) save();
  return out;
}

export function cashRuns() {
  if (!Array.isArray(state.cashRuns)) state.cashRuns = [];
  return state.cashRuns;
}

export function addCashRun(run) {
  const items = (run.items || []).filter((i) => Number(i.amount) > 0);
  // An explicit amount wins over the items. A till slip's lines often do not
  // sum to its total - an unread row, a discount, a VAT line - and the total is
  // what you actually handed over, so that is what leaves the pocket. The items
  // stay as description. The pad passes no amount and is unaffected.
  const amount = Number(run.amount) > 0
    ? Number(run.amount)
    : items.reduce((a, i) => a + Number(i.amount), 0);
  if (amount <= 0) return null;
  const row = {
    id: run.id || `cash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    date: run.date || new Date().toISOString().slice(0, 10),
    category: run.category || 'Groceries',
    amount,
    items: items.map((i) => ({ name: String(i.name || '').trim(), amount: Number(i.amount) })),
    note: run.note || '',
  };
  cashRuns().push(row);
  save();
  return row;
}

/** Cash you were given: it joins the pocket like a withdrawal, from its date. */
export function cashIn() {
  if (!Array.isArray(state.cashIn)) state.cashIn = [];
  return state.cashIn;
}

export function addCashIn(gift) {
  const amount = Number(gift.amount) || 0;
  if (amount <= 0) return null;
  const row = {
    id: `cashin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    date: gift.date || new Date().toISOString().slice(0, 10),
    amount,
    note: String(gift.note || '').trim(),
  };
  cashIn().push(row);
  save();
  return row;
}

export function removeCashIn(id) {
  const list = cashIn();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  save();
  return true;
}

export function removeCashRun(id) {
  const list = cashRuns();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  save();
  return true;
}

export function undatedTransactions() {
  return Object.values(state.transactions).filter((t) => !t.date);
}

export function removeUndated() {
  const gone = undatedTransactions();
  for (const t of gone) delete state.transactions[t.id];
  if (gone.length) save();
  return gone.length;
}

export function removePayable(id) {
  state.payables = payables().filter((p) => p.id !== id);
  save();
}

export function addPayable(p) {
  const id = `custom-${Date.now()}`;
  payables().push({ id, manualPaid: 0, ...p });
  save();
  return id;
}

export function addCategory(name, cls) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'Type a category name first.' };
  if (state.customCategories.some((c) => c.name.toLowerCase() === n.toLowerCase())) {
    return { ok: false, error: `“${n}” already exists.` };
  }
  state.customCategories.push({ name: n, class: cls || 'spending' });
  save();
  return { ok: true, name: n };
}

/**
 * Removing a category must not leave rules pointing at something that no longer
 * exists — those transactions would render a dropdown with no matching option and
 * silently read as the first category in the list. So the rules and overrides that
 * used it are dropped too, and everything they held falls back to Uncategorised.
 */
export function removeCategory(name) {
  state.customCategories = state.customCategories.filter((c) => c.name !== name);
  state.nameRules = state.nameRules.filter((r) => r.category !== name);
  state.userRules = state.userRules.filter((r) => r.category !== name);
  for (const [id, cat] of Object.entries(state.overrides)) {
    if (cat === name) delete state.overrides[id];
  }
  save();
}

/** What a category removal would take with it — shown before confirming. */
export function categoryUsage(name) {
  const rules = state.nameRules.filter((r) => r.category === name).length;
  const overrides = Object.values(state.overrides).filter((c) => c === name).length;
  return { rules, overrides };
}

// Name rules match a fragment anywhere in the counterparty, which is what makes them
// worth having: M-PESA masks the same person's number differently in an SMS
// (07******156) and in a statement (2547******156), so an exact-string rule catches
// only one of them. "kamuyu" catches both.
/**
 * Clear anything that would outrank a name rule for `name`.
 *
 * Exact-counterparty rules and per-transaction overrides are checked BEFORE name
 * rules, and earlier versions of this app created exact rules on every edit. They
 * are invisible in the UI, so a stale one silently beats whatever you set now and
 * nothing you can see explains why. An explicit instruction must win over state you
 * can't inspect.
 *
 * @returns {number} how many stale entries were dropped
 */
function purgeConflicts(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return 0;
  let dropped = 0;

  const keep = state.userRules.filter((r) => !String(r.counterparty || '').toLowerCase().includes(q));
  dropped += state.userRules.length - keep.length;
  state.userRules = keep;

  for (const [id, _cat] of Object.entries(state.overrides)) {
    const t = state.transactions[id];
    if (t && String(t.counterparty || '').toLowerCase().includes(q)) {
      delete state.overrides[id];
      dropped++;
    }
  }
  return dropped;
}

export function addNameRule(match, category) {
  const m = String(match || '').trim();
  if (!m) return { ok: false, error: 'Type a name first.' };
  const purged = purgeConflicts(m);
  const dupe = state.nameRules.find((r) => r.match.toLowerCase() === m.toLowerCase());
  if (dupe) dupe.category = category;
  else state.nameRules.push({ match: m, category });
  save();
  return { ok: true, purged };
}

export function removeNameRule(match) {
  state.nameRules = state.nameRules.filter((r) => r.match !== match);
  save();
}

/** How many stored transactions a fragment would catch — shown before you commit. */
export function countMatching(fragment) {
  return ledgerFor(fragment).count;
}

/**
 * Money out, money back, and what's left — for everyone matching a name fragment.
 * This is what answers "did they ever pay me back?": lending shows up as money
 * out and money in to the same person, and only the net of the two means anything.
 */
export function ledgerFor(fragment) {
  const q = String(fragment || '').trim().toLowerCase();
  const empty = { out: 0, in: 0, net: 0, count: 0, first: null, last: null, mpesa: 0, bank: 0 };
  if (!q) return empty;

  let out = 0;
  let inn = 0;
  let count = 0;
  let first = null;
  let last = null;
  let mpesa = 0;
  let bank = 0;

  for (const t of Object.values(state.transactions)) {
    if (!`${t.counterparty || ''}`.toLowerCase().includes(q)) continue;
    count++;
    if (t.direction === 'Out') out += t.amount;
    else inn += t.amount;
    // Anything without an explicit source predates the bank importer and is M-PESA.
    if ((t.accountSource || 'mpesa') === 'bank') bank++;
    else mpesa++;
    if (t.date) {
      if (!first || t.date < first) first = t.date;
      if (!last || t.date > last) last = t.date;
    }
  }
  return { out, in: inn, net: out - inn, count, first, last, mpesa, bank };
}

/** Every transaction whose counterparty contains this fragment. */
export function rowsFor(fragment) {
  const q = String(fragment || '').trim().toLowerCase();
  if (!q) return [];
  return Object.values(state.transactions).filter((t) =>
    `${t.counterparty || ''}`.toLowerCase().includes(q)
  );
}

export function seedOnce(rows) {
  if (state.seeded) return { added: 0, duplicate: 0 };
  const res = addTransactions(rows);
  state.seeded = true;
  save();
  return res;
}

export function exportJSON() {
  return JSON.stringify(state, null, 1);
}

/**
 * Merge another device's backup into this one.
 *
 * This is how the phone and the laptop stay in step, so it has to merge EVERYTHING,
 * not just transactions. It previously took transactions, userRules and overrides and
 * silently ignored name rules, payables, budgets, settings, custom categories and
 * refund links — importing would have quietly wiped the categorisation work and left
 * no sign it had.
 *
 * Two shapes of data, two rules:
 *
 *   additive  — transactions, rules, categories, links. Union, keyed so re-importing
 *               the same file changes nothing. This is why merging is safe in either
 *               direction and can be repeated.
 *
 *   settable  — a budget amount, a debt balance, the small-send limit. One value, and
 *               two devices can disagree. **The incoming file wins.** Import the older
 *               device into the newer and you'd overwrite a figure you'd just fixed —
 *               so the summary says exactly what changed rather than leaving you to
 *               discover it.
 *
 * @returns {object} counts of what came in, for reporting
 */
export function importJSON(text) {
  const incoming = JSON.parse(text);
  if (!incoming || typeof incoming.transactions !== 'object') {
    throw new Error("That file doesn't look like a tracker backup.");
  }

  const before = Object.keys(state.transactions).length;

  // --- transactions: keyed by receipt, so this can't double-count.
  for (const [id, t] of Object.entries(incoming.transactions)) {
    const mine = state.transactions[id];
    // A statement is authoritative over an SMS for the same receipt.
    if (!mine || (t.source === 'statement' && mine.source !== 'statement')) state.transactions[id] = t;
  }
  const added = Object.keys(state.transactions).length - before;

  // --- rules: union, deduped by their key, incoming wins a clash.
  const mergeBy = (mineArr, theirsArr, key) => {
    const out = new Map((mineArr || []).map((x) => [String(x[key]).toLowerCase(), x]));
    let fresh = 0;
    for (const x of theirsArr || []) {
      const k = String(x[key]).toLowerCase();
      if (!out.has(k)) fresh++;
      out.set(k, x);
    }
    return { list: [...out.values()], fresh };
  };

  const nr = mergeBy(state.nameRules, incoming.nameRules, 'match');
  state.nameRules = nr.list;
  const ur = mergeBy(state.userRules, incoming.userRules, 'counterparty');
  state.userRules = ur.list;
  const cc = mergeBy(state.customCategories, incoming.customCategories, 'name');
  state.customCategories = cc.list;

  state.overrides = { ...state.overrides, ...(incoming.overrides || {}) };
  state.splits = { ...state.splits, ...(incoming.splits || {}) };
  state.budgetMonths = { ...state.budgetMonths, ...(incoming.budgetMonths || {}) };
  state.refundLinks = { ...state.refundLinks, ...(incoming.refundLinks || {}) };

  // --- itemised cash: additive, keyed by id. Typed on whichever device was in
  // your hand at the market, so the union is the only merge that keeps both.
  state.receiptCash = { ...(state.receiptCash || {}), ...(incoming.receiptCash || {}) };

  if (Array.isArray(incoming.cashRuns)) {
    const mine = new Map(cashRuns().map((r) => [r.id, r]));
    for (const r of incoming.cashRuns) mine.set(r.id, r);
    state.cashRuns = [...mine.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  if (Array.isArray(incoming.cashIn)) {
    const mine = new Map(cashIn().map((r) => [r.id, r]));
    for (const r of incoming.cashIn) mine.set(r.id, r);
    state.cashIn = [...mine.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  // --- payables: merge by id. Money recorded by hand and linked payments are
  // additive (each device may have recorded different ones), so take the union
  // rather than let one side's list replace the other's.
  if (Array.isArray(incoming.payables)) {
    const mine = new Map((state.payables || []).map((p) => [p.id, p]));
    for (const p of incoming.payables) {
      const m = mine.get(p.id);
      mine.set(
        p.id,
        m
          ? {
              ...m,
              ...p,
              manualPaid: Math.max(m.manualPaid || 0, p.manualPaid || 0),
              linkedIds: [...new Set([...(m.linkedIds || []), ...(p.linkedIds || [])])],
            }
          : p
      );
    }
    state.payables = [...mine.values()];
    state.payablesSeed = Math.max(state.payablesSeed || 0, incoming.payablesSeed || 0);
  }

  if (Array.isArray(incoming.budgets)) {
    const mine = new Map((state.budgets || []).map((b) => [b.id, b]));
    for (const b of incoming.budgets) {
      const m = mine.get(b.id);
      // Only the amount is a user value; the categories a line covers are code-owned
      // structure. If the incoming file's categories won, an older device could carry
      // stale mappings back onto a line this device already fixed. Take the amount,
      // keep our own line definition. A line we don't have at all (one the user added)
      // comes across whole. budgetSeed is deliberately not carried, so this device's
      // own version gate still gets to re-sync structure on the next budgets() call.
      mine.set(b.id, m ? { ...m, amount: b.amount } : b);
    }
    state.budgets = [...mine.values()];
  }

  // --- settings: identifiers are additive (a device may know a number the other
  // doesn't); the limit is a single value, so incoming wins.
  if (incoming.settings) {
    const s = settings();
    const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    const people = new Map((s.people || []).map((p) => [p.number, p]));
    for (const p of incoming.settings.people || []) people.set(p.number, p);
    state.settings = {
      name: incoming.settings.name || s.name || '',
      phones: union(s.phones, incoming.settings.phones),
      accounts: union(s.accounts, incoming.settings.accounts),
      people: [...people.values()],
      smallSendLimit: incoming.settings.smallSendLimit ?? s.smallSendLimit,
    };
    applySettings();
  }

  state.seeded = true;
  resolveIdentities();
  save();

  return {
    added,
    duplicate: Object.keys(incoming.transactions).length - added,
    nameRules: nr.fresh,
    userRules: ur.fresh,
    categories: cc.fresh,
    payables: Array.isArray(incoming.payables) ? incoming.payables.length : 0,
    settingsMerged: Boolean(incoming.settings),
  };
}

export function reset() {
  state = empty();
  save();
}

/* ---- Shopping receipts from the phone app -------------------------------- */

export function receipts() {
  if (!Array.isArray(state.receipts)) state.receipts = [];
  return state.receipts;
}

export function receiptLinks() {
  if (!state.receiptLinks) state.receiptLinks = {};
  return state.receiptLinks;
}

/**
 * Takes in receipts, replacing any already held under the same id, and keeps
 * the newest first. Re-pasting the same backup is therefore harmless.
 */
export function importReceipts(incoming) {
  const existing = receipts();
  const byId = new Map(existing.map((r) => [r.id, r]));
  let added = 0;
  let replaced = 0;
  for (const receipt of incoming) {
    if (byId.has(receipt.id)) replaced += 1;
    else added += 1;
    byId.set(receipt.id, receipt);
  }
  state.receipts = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  save();
  return { added, replaced, total: state.receipts.length };
}

/**
 * Book a receipt as paid in cash.
 *
 * The receipt's items become the run's items, so the cash is described to the
 * same depth as the slip was - which is the whole reason for scanning it.
 */
export function payReceiptInCash(receiptId, category = 'Groceries') {
  const r = receipts().find((x) => x.id === receiptId);
  if (!r) return null;
  if (!state.receiptCash) state.receiptCash = {};
  if (state.receiptCash[receiptId]) return null; // already booked; no double count

  const items = (r.items || [])
    .map((i) => ({ name: String(i.name || '').trim(), amount: Number(i.price) * Number(i.qty || 1) }))
    .filter((i) => i.name && i.amount > 0);

  const run = addCashRun({
    date: r.date,
    category,
    items,
    // A slip total can differ from the sum of its lines (a rounding, a discount
    // the scan did not read). The slip is what you handed over, so it wins.
    amount: r.slipTotal != null ? r.slipTotal : undefined,
    note: `receipt ${receiptId}`,
  });
  if (!run) return null;
  state.receiptCash[receiptId] = run.id;
  save();
  return run;
}

/** Undo that, taking the cash run with it. */
export function unpayReceiptInCash(receiptId) {
  const id = state.receiptCash && state.receiptCash[receiptId];
  if (!id) return false;
  removeCashRun(id);
  delete state.receiptCash[receiptId];
  save();
  return true;
}

export function receiptCash() {
  if (!state.receiptCash) state.receiptCash = {};
  return state.receiptCash;
}

export function setReceiptLinks(links) {
  state.receiptLinks = { ...receiptLinks(), ...links };
  save();
}

export function unlinkReceipt(receiptId) {
  const links = receiptLinks();
  delete links[receiptId];
  save();
}

export function removeReceipt(receiptId) {
  state.receipts = receipts().filter((r) => r.id !== receiptId);
  unlinkReceipt(receiptId);
  save();
}
