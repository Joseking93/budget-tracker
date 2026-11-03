// Shopping receipts from the Basket Budget phone app.
//
// The two apps cannot talk to each other — one lives on a phone, one in this
// browser, and both keep everything in local storage. The bridge is the text
// its "Copy everything" button puts on the clipboard, pasted in here.
//
// What that buys: a statement line says what went to the supermarket on a day.
// The receipt says what it bought. Linking them turns one grocery number into
// fifty-odd answerable ones.

/** Nairobi is UTC+3 and never shifts, so the local day is a fixed offset. */
export function localDay(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso).slice(0, 10);
  return new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function receiptTotal(receipt) {
  return (receipt.items || []).reduce((sum, i) => sum + (+i.price || 0) * (+i.qty || 1), 0);
}

/**
 * Reads what the phone app copied. BASKET2 carries the receipts; BASKET1 is
 * the older basket-only form and yields none.
 */
export function parseBasket(text) {
  let body = String(text || '').trim();
  const tagged = /^BASKET([12]):/.exec(body);
  if (tagged) body = body.slice(tagged[0].length);
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('That is not a copied Basket Budget list.');
  }
  if (!data || typeof data !== 'object') throw new Error('That is not a copied Basket Budget list.');

  const receipts = (Array.isArray(data.receipts) ? data.receipts : [])
    .filter((r) => r && r.date && Array.isArray(r.items))
    .map((r) => ({
      id: String(r.id || 'r' + r.date + '-' + Math.random().toString(36).slice(2, 7)),
      date: String(r.date).slice(0, 10),
      slipTotal: r.slipTotal == null ? null : +r.slipTotal,
      items: r.items.map((i) => ({
        name: String(i.name || 'Item'),
        qty: Math.max(1, +i.qty || 1),
        price: +i.price || 0,
      })),
    }));

  return { budget: data.budget == null ? null : +data.budget, receipts };
}

/**
 * Finds the statement line a receipt paid for.
 *
 * The amount is what identifies it — two shops on one day for the same total
 * to the shilling would be a remarkable coincidence. The date is allowed to
 * drift by a day because a late-evening till receipt can settle after
 * midnight, and because the slip's own date is what the phone read off paper.
 */
export function matchReceipt(receipt, txns, { taken = new Set() } = {}) {
  const total = receipt.slipTotal != null ? receipt.slipTotal : receiptTotal(receipt);
  if (!(total > 0)) return null;

  const candidates = txns.filter((t) => {
    if (taken.has(t.id)) return false;
    const amount = Math.abs(+t.amount || 0);
    return Math.abs(amount - total) <= 1;
  });
  if (!candidates.length) return null;

  // The shop, when the slip carried one, settles a tie. Two payments for the
  // same total on the same day used to be a coin toss; now the one whose
  // merchant is named on the slip wins. Letters only on both sides, because
  // the slip says "Quickmart" and M-PESA says "QUICK MART EMBAKASI".
  const shop = letters(receipt.shop);
  const named = (t) => Boolean(shop) && letters(t.counterparty).includes(shop);

  const scored = candidates
    .map((t) => ({ txn: t, days: dayGap(localDay(t.date), receipt.date), named: named(t) }))
    .filter((c) => c.days <= 1)
    .sort((a, b) => a.days - b.days || Number(b.named) - Number(a.named));

  return scored.length ? scored[0].txn : null;
}

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function dayGap(a, b) {
  const x = Date.parse(a + 'T00:00:00Z');
  const y = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(x) || Number.isNaN(y)) return 99;
  return Math.abs(x - y) / 86400000;
}

/** Links every receipt it can, never giving one transaction to two receipts. */
export function matchAll(receipts, txns) {
  const taken = new Set();
  const links = {};
  // Biggest first: a large total is the least ambiguous, so it gets first
  // claim on a transaction before a 50-shilling receipt can take it.
  const order = [...receipts].sort((a, b) => receiptTotal(b) - receiptTotal(a));
  for (const receipt of order) {
    const txn = matchReceipt(receipt, txns, { taken });
    if (txn) {
      links[receipt.id] = txn.id;
      taken.add(txn.id);
    }
  }
  return links;
}

/**
 * What each thing has cost across every receipt, biggest first. This is the
 * question the statement alone can never answer.
 */
export function itemTotals(receipts, { from = '', to = '' } = {}) {
  const by = new Map();
  for (const receipt of receipts) {
    if (from && receipt.date < from) continue;
    if (to && receipt.date > to) continue;
    for (const item of receipt.items) {
      const key = item.name.trim().toLowerCase();
      const row = by.get(key) || { name: item.name.trim(), total: 0, qty: 0, times: 0 };
      row.total += item.price * item.qty;
      row.qty += item.qty;
      row.times += 1;
      by.set(key, row);
    }
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/** Every line matching a search, newest first, for "what do I pay for rice". */
export function findItems(receipts, query) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return [];
  const hits = [];
  for (const receipt of receipts) {
    for (const item of receipt.items) {
      if (item.name.toLowerCase().includes(term)) {
        hits.push({ date: receipt.date, receiptId: receipt.id, item });
      }
    }
  }
  return hits.sort((a, b) => (a.date < b.date ? 1 : -1));
}
