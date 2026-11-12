// What your lenders say.
//
// The wallet records money moving: a draw landing, a repayment leaving. It
// cannot record what a lender THINKS you owe, when it wants it, or what it
// charged for lending it - those arrive as the lender's own messages, which
// the parser used to throw away as "not a transaction". They are not
// transactions. They are the ledger, and this reads them as one.
//
// Per lender, the latest statement of what is owed ("repayment of KES 6,597
// is due on 05/12") is the anchor. Repayments the wallet or the bank has
// recorded SINCE that message come off it; a "fully paid" newer than it
// closes it. The fee on the latest draw, against what was borrowed and the
// days it was borrowed for, is the price - and the price is what tells two
// loans apart.

/** A name the way the ledger files it: letters only, lower case, one spelling per lender. */
export function lenderKey(name) {
  const s = String(name || '').toLowerCase();
  if (/m-?shwari/.test(s)) return 'M-Shwari';
  if (/kcb\s*m-?pesa/.test(s)) return 'KCB M-PESA';
  if (/kcb\s*mobile|mobi\s*loan|kcb\b/.test(s)) return 'KCB Mobile Loan';
  if (/vooma/.test(s)) return 'Vooma Loan';
  if (/fuliza/.test(s)) return 'Fuliza';
  if (/tala\b/.test(s)) return 'Tala';
  if (/branch\b/.test(s)) return 'Branch';
  if (/zenka/.test(s)) return 'Zenka';
  if (/timiza/.test(s)) return 'Timiza';
  if (/hustler/.test(s)) return 'Hustler Fund';
  if (/ncba/.test(s)) return 'NCBA';
  return String(name || '').trim();
}

const day = (iso) => String(iso || '').slice(0, 10);
const days = (a, b) => Math.round((Date.parse(day(b)) - Date.parse(day(a))) / 86400000);

/**
 * One row per lender.
 *
 * @param {object[]} notices  {kind: drawn|due|repaid|cleared, lender, at, principal?, fee?, due?, dueDate?, amount?}
 * @param {object[]} txns     decorated wallet rows (category, counterparty, direction, amount, date, type)
 * @param {string}   today    YYYY-MM-DD
 */
export function loanLedger(notices, txns, today) {
  const byLender = new Map();
  for (const n of notices) {
    const key = lenderKey(n.lender);
    if (!key) continue;
    if (!byLender.has(key)) byLender.set(key, []);
    byLender.get(key).push(n);
  }

  const rows = [];
  for (const [lender, list] of byLender) {
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const drawn = [...list].reverse().find((n) => n.kind === 'drawn') || null;
    // The newest message that STATES a figure owed is the anchor. A draw with a
    // repayment figure counts; so does a reminder.
    const stated = [...list].reverse().find((n) => (n.kind === 'drawn' || n.kind === 'due') && n.due > 0) || null;
    const cleared = [...list].reverse().find((n) => n.kind === 'cleared') || null;

    // Repayments since the anchor: what the wallet sent to this lender, plus
    // what the bank said it received - the same payment can appear on both
    // sides (a paybill from M-PESA, then the bank's receipt), so a bank notice
    // within a shilling of a wallet row on the same day is the same money.
    const since = stated ? stated.at : '';
    const wallet = txns.filter(
      (t) =>
        t.direction === 'Out' &&
        /Loan Repayment|Pay ?Bill|Loans & Credit/i.test(`${t.type} ${t.category}`) &&
        lenderKey(t.counterparty) === lender &&
        t.date > since,
    );
    const bank = list.filter((n) => n.kind === 'repaid' && n.at > since);
    // One payment, several messages: the wallet's own row, the bank's "request
    // received", the bank's "payment received for loan N". Within a shilling on
    // the same day they are the same money, whichever side said it.
    const seen = wallet.map((t) => ({ amount: t.amount, day: day(t.date) }));
    let repaid = wallet.reduce((s, t) => s + t.amount, 0);
    for (const n of bank) {
      const twin = seen.find((w) => Math.abs(w.amount - n.amount) <= 1 && w.day === day(n.at));
      if (twin) continue;
      seen.push({ amount: n.amount, day: day(n.at) });
      repaid += n.amount;
    }

    // A balance and "is now fully paid" can land in the same minute - the
    // balance sentence describes the state before the final sweep - so a
    // clearing at the same time as the statement wins.
    const closedAfter = cleared && stated && cleared.at >= stated.at;
    const isCleared = Boolean(closedAfter || (cleared && !stated));
    // Nothing stated, nothing cleared, no draw: nothing to say about it.
    if (!stated && !cleared && !drawn) continue;
    // A clearing is news for a while; a loan paid off years ago is not a row.
    if (isCleared && cleared && today && days(day(cleared.at), today) > 60) continue;
    const openingOwed = stated ? stated.due : drawn ? (drawn.principal || 0) + (drawn.fee || 0) : 0;
    const owed = isCleared ? 0 : Math.max(0, openingOwed - repaid);

    // The price. The fee is charged on the whole facility the due figure
    // covers, not only on today's top-up: a 1,120 top-up with a 527 fee on a
    // 6,597 repayment is a fee on 6,070 of borrowing, not 47% on 1,120.
    let price = null;
    if (drawn && drawn.fee > 0) {
      const base = drawn.due > drawn.fee ? drawn.due - drawn.fee : drawn.principal;
      const term = drawn.dueDate ? Math.max(1, days(drawn.at, drawn.dueDate)) : null;
      const rate = base > 0 ? drawn.fee / base : null;
      price = {
        fee: drawn.fee,
        on: base,
        rate,
        termDays: term,
        monthly: rate != null && term ? rate * (30 / term) : null,
      };
    }

    rows.push({
      lender,
      owed,
      stated: stated ? stated.due : drawn ? openingOwed : null,
      statedAt: stated ? day(stated.at) : drawn ? day(drawn.at) : null,
      dueDate: stated && stated.dueDate ? stated.dueDate : null,
      daysLeft: stated && stated.dueDate && today ? days(today, stated.dueDate) : null,
      repaidSince: repaid,
      cleared: isCleared,
      clearedAt: cleared ? day(cleared.at) : null,
      price,
      lastNotice: day(list[list.length - 1].at),
      notices: list.length,
    });
  }

  // The expensive ones first; anything cleared sits at the bottom.
  return rows.sort((a, b) => {
    if (a.cleared !== b.cleared) return a.cleared ? 1 : -1;
    const pa = a.price && a.price.monthly != null ? a.price.monthly : -1;
    const pb = b.price && b.price.monthly != null ? b.price.monthly : -1;
    return pb - pa || b.owed - a.owed;
  });
}
