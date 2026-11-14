// Monthly budgets.
//
// Budget LINES are structure — which app categories a household line covers — and
// belong in the code. The AMOUNTS are yours, so they ship at zero and live in your
// browser's storage. What someone budgets for rent says a lot about them, and this
// code has to be hosted for a phone to install it.
//
// The lines don't map 1:1 onto categories, because a household thinks in intents
// ("rent + water + gas") while the app categorises by what the merchant is. Each
// line therefore covers a LIST of categories, stated rather than guessed at.

import { classOf, CLASSES, categoryParts } from './rules.js';
import { monthResolver, cycleStartOf } from './salary.js';

// Bump when the LINES change (a new line, a re-mapped category) so installs that
// already stored the old lines pick up the new structure — see store.budgets().
// v2: split Electricity + Househelp onto their own categories, and gave every
// remaining spending category a line so nothing real hides in "outside any budget".
export const BUDGET_SEED_VERSION = 3;

// Every SPENDING category maps to exactly one line here, except Uncategorised — that
// one is left out on purpose so "outside any budget" means "money I haven't identified
// yet", a triage list, rather than a vague catch-all. Transfers, savings, loan
// repayments and fees are not spending and never belong on a budget line (budgetReport
// filters them out of the outside figure too).
export const DEFAULT_BUDGETS = [
  { id: 'rent', label: 'Rent, water & gas', amount: 0, categories: ['Rent & Housing', 'Utilities & Power'] },
  { id: 'fibre', label: 'Home fibre & online', amount: 0, categories: ['Internet', 'Subscriptions', 'Airtime & Data'] },
  { id: 'power', label: 'Electricity', amount: 0, categories: ['Electricity'] },
  { id: 'help', label: 'Househelp salary', amount: 0, categories: ['Household Staff'] },
  { id: 'fun', label: 'Entertainment', amount: 0, categories: ['Entertainment'] },
  { id: 'food', label: 'Groceries', amount: 0, categories: ['Groceries'] },
  { id: 'car', label: 'Fuel, transport & car', amount: 0, categories: ['Transport & Fuel', 'Car & Mechanic'] },
  { id: 'repairs', label: 'Repairs & maintenance', amount: 0, categories: ['Repairs & Maintenance'] },
  { id: 'shop', label: 'Shopping & services', amount: 0, categories: ['Shopping', 'Personal Care', 'Health & Pharmacy'] },
  { id: 'family', label: 'Family & support', amount: 0, categories: ['Family'] },
  { id: 'misc', label: 'Cash, fees & other', amount: 0, categories: ['Cash Withdrawal', 'Government & Fees', 'Sent to People', 'Other'] },
];

/**
 * Actual against budget for one month.
 * `spent` only counts categories the budget claims, so uncategorised money is
 * excluded — a budget you can meet by not knowing where money went is worthless.
 */
// The financial month runs from payday, not the 1st — see js/salary.js, which owns
// that rule so the budget, the monthly report and the per-line trend all agree.

export function budgetReport(budgets, txns, month) {
  const budgetMonthOf = monthResolver(txns);
  // When this month runs from a payday rather than the 1st, say so — a budget whose
  // boundaries you can't see is one you can't check.
  const cycleStart = cycleStartOf(month);

  // Expand to category-parts FIRST, then keep the slices whose budget month is this
  // one — so a split (househelp → July, groceries → June) lands each slice on
  // the right line in the right month, and a whole payment pulled in from another
  // month shows up here too.
  const rows = txns
    .filter((t) => t.direction === 'Out')
    .flatMap(categoryParts)
    .filter((p) => budgetMonthOf(p) === month);

  const claimed = new Set(budgets.flatMap((b) => b.categories));
  const report = budgets.map((b) => {
    const mine = rows.filter((t) => b.categories.includes(t.category));
    const spent = mine.reduce((a, t) => a + t.amount, 0);
    return {
      ...b,
      spent,
      left: b.amount - spent,
      pct: b.amount > 0 ? spent / b.amount : 0,
      over: spent > b.amount,
      count: mine.length,
      unmapped: b.categories.length === 0,
    };
  });

  const budgeted = budgets.reduce((a, b) => a + b.amount, 0);
  const spent = report.reduce((a, r) => a + r.spent, 0);
  // Money that left but no budget covers — the honest remainder.
  //
  // Spending AND fees. Transfers stay out: an outbound bank transfer, a loan repayment
  // or money moved to savings isn't budget spending, and lumping it here (the Zenka
  // repayment alone is tens of thousands) would drown what this figure is for.
  //
  // Fees belong here even though they're their own class. M-PESA's cut is money that
  // genuinely left, and no household budget line claims it — so leaving it out of BOTH
  // the lines and this figure made it vanish from the budget entirely, while the
  // monthly report (which counts spending + fees) still showed it. The panels then
  // disagreed by exactly the fees and nothing on screen explained why. With fees here,
  //   lines + outside == the monthly report's "spent"
  // and the two tally.
  const outsideRows = rows.filter(
    (t) => !claimed.has(t.category) && [CLASSES.SPENDING, CLASSES.FEE].includes(classOf(t.category))
  );
  const outside = outsideRows.reduce((a, t) => a + t.amount, 0);

  // Itemised, so "outside any budget" is never an opaque lump. A large one-off or
  // an uncategorised person-send hiding inside one number reads as "money vanished";
  // named with its total next to it, it reads as "spending I haven't put on a line
  // yet" — which is either a category worth adding to a line, or something to go and
  // categorise. Custom categories the user made (which no seed line can know about)
  // surface here too, instead of falling through invisibly.
  const grouped = outsideRows.reduce((m, t) => ((m[t.category] = (m[t.category] || 0) + t.amount), m), {});
  const outsideItems = Object.entries(grouped)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  // What's funding this month. Pay received on the 28th usually covers the month that
  // follows, so income counts toward its ASSIGNED budget month when it has one — the
  // same rule spending follows — and its own date otherwise.
  const fundedRows = txns.filter(
    (t) => t.direction === 'In' && classOf(t.category) === CLASSES.INCOME && budgetMonthOf(t) === month
  );
  const funded = fundedRows.reduce((a, t) => a + t.amount, 0);

  return {
    report,
    budgeted,
    spent,
    left: budgeted - spent,
    outside,
    outsideItems,
    funded,
    fundedCount: fundedRows.length,
    cycleStart,
  };
}

/**
 * The amount a line had in force in a month, from its amount log.
 *
 * Budgets store only the CURRENT amount, so a line that went from 3,500 to
 * 4,000 in March would read every earlier month against 4,000 and call them
 * all under. The log (store.budgetAmountLog) keeps each change with the month
 * it took effect; the latest entry whose `since` is on or before the month
 * wins, and a month before any entry falls back to the current amount.
 */
export function amountInForce(log, month, current) {
  let hit = null;
  for (const e of log || []) if (e && e.since <= month && (!hit || e.since >= hit.since)) hit = e;
  return hit ? hit.amount : current;
}

/**
 * Spent per line per month, for a run of months, in one pass.
 *
 * budgetReport answers one month and walks every transaction to do it, so
 * asking it eighteen times walks them eighteen times - which is what made the
 * app lag once. This expands the spending to category-parts and resolves each
 * part's budget month ONCE, then buckets it, so the cost is one walk however
 * many months are asked for. It counts exactly what budgetReport counts:
 * money Out, by category-part, on the budget month the part resolves to.
 *
 * @param {Array} budgets   the lines, as store.budgets() gives them
 * @param {Array} txns      decorated transactions (categories and splits on)
 * @param {string[]} months ISO 'YYYY-MM', oldest first
 * @param {Object} [amountLog] id -> [{since, amount}], see amountInForce
 */
export function budgetHistory(budgets, txns, months, amountLog = {}) {
  const at = new Map(months.map((m, i) => [m, i]));
  // A category can sit on more than one line, and budgetReport counts it on
  // each, so this does too.
  const linesOf = new Map();
  budgets.forEach((b, i) => {
    for (const c of b.categories || []) {
      if (!linesOf.has(c)) linesOf.set(c, []);
      linesOf.get(c).push(i);
    }
  });
  const spent = budgets.map(() => new Float64Array(months.length));
  const budgetMonthOf = monthResolver(txns);
  for (const t of txns) {
    if (t.direction !== 'Out') continue;
    for (const p of categoryParts(t)) {
      const lines = linesOf.get(p.category);
      if (!lines) continue;
      const i = at.get(budgetMonthOf(p));
      if (i === undefined) continue;
      for (const l of lines) spent[l][i] += p.amount;
    }
  }
  return budgets.map((b, l) => ({
    id: b.id,
    label: b.label,
    categories: b.categories || [],
    amount: b.amount,
    months: months.map((month, i) => {
      const amount = amountInForce(amountLog[b.id], month, b.amount);
      const s = spent[l][i];
      return { month, spent: s, amount, over: amount > 0 && s > amount };
    }),
  }));
}

/**
 * One sentence that reads a line's last twelve months for you.
 *
 * `months` is the line's history, oldest first, ending at the month being
 * looked at. Only its last twelve are read. `covered` is how many of those
 * twelve the data on file actually reaches back over: with three months of
 * messages, "under every month for a year" would be claiming nine months
 * nobody has seen. Returns the words, a tone ('bad' | 'good' | '') and how
 * many months were over, which is what the History list sorts on.
 */
export function historyVerdict(months, covered = 12) {
  const last = months.slice(-12);
  const now = last[last.length - 1];
  const spentAny = last.filter((m) => m.spent > 0);
  if (!spentAny.length) return { text: 'Nothing spent yet', tone: '', over: 0 };
  const over = last.filter((m) => m.over).length;
  // Paid in full and no more, every month there was a payment: a salary, a
  // rent. "Under" would be wrong and "over" would be wrong.
  if (spentAny.every((m) => m.amount > 0 && Math.abs(m.spent - m.amount) <= 1)) {
    return { text: 'The full amount, every month', tone: '', over };
  }
  if (!over) return { text: covered >= 12 ? 'Under every month for a year' : 'Under every month so far', tone: 'good', over };
  const year = now.month.slice(0, 4);
  if (!last.some((m) => m.over && m.month.startsWith(year))) {
    return { text: 'Under every month this year', tone: 'good', over };
  }
  const text = `Over ${over} of the last 12 months${now.over ? ', this one too' : ''}`;
  return { text, tone: over >= 4 ? 'bad' : '', over };
}
