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
