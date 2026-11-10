import { parseMessages, groupUnparsed } from './parser.js';
import {
  categorise,
  CLASSES,
  CATEGORIES,
  classOf,
  LENDER_RE,
  ONE_OFF_CATEGORIES,
  personName,
  registerCustomCategories,
  isBuiltInCategory,
  categoryParts,
} from './rules.js';
import * as store from './store.js';
import * as viz from './dashboard.js';
import { reconcileAccounts } from './reconcile.js';
import { computePayable } from './payables.js';
import { monthsIn, monthLabel, compareMonths, biggestDriver, nextMonth } from './monthly.js';
import { salaryRuns, monthResolver, cycleMonthOf } from './salary.js';
import { balanceSeries, lowDays, fulizaReport } from './balance.js';
import { findRecurring, committedMonthly } from './recurring.js';
import { budgetReport } from './budgets.js';
import { loanLedger } from './loans.js';
import * as basket from './basket.js';
import { ACCOUNT_LABELS } from './import.js';
import * as cash from './cash.js';
import { emojiOf, glyphFor, glyphMap } from './icons.js';
import { cycleStartOf } from './salary.js';
import { suggestFor, guessFor } from './suggest.js';
import { isConfigured, norm as normNumber, ASSET_BUILD, CYCLE_DAY } from './config.js';

const rampFor = (i, n) => viz.rampAt(i, n);

const $ = (s) => document.querySelector(s);
const state = {
  range: 'all',
  search: '',
  catFilter: 'all',
  // A SET of categories, for the ring's folded slice - which stands for several
  // and so cannot be expressed as catFilter, a single name.
  drillCats: null,
  // What to call that set on screen: a budget line's name, or the ring's fold.
  drillCatsLabel: '',
  // The budget line the list came from, so you can go and change it from here
  // rather than going back and finding it again.
  drillBudget: null,
  dirFilter: 'all',
  acctFilter: 'all',
  showSettled: false,
  month: null,
  // Which budget line / category the "Track a budget line" panel is following.
  track: null,
  drillMonth: null,
  // A plain date window, for the figures that count days rather than months -
  // today, and the last seven.
  drillFrom: null,
  drillTo: null,
  // 'spending' narrows to money actually consumed, leaving out transfers and
  // loan repayments - so a list opened from the spending figure adds up to it.
  drillClass: null,
  balAcct: null,
  sort: { key: 'date', dir: 'desc' },
  // How many rows of the transaction list are on screen. Everything is still
  // there - this is what gets built into the page.
  txnLimit: 150,
};

// Categories are derived on read, never baked into the stored transaction — so
// editing a rule instantly recategorises history instead of only new imports.
const WHY = {
  user: 'an exact rule for this counterparty',
  name: 'a name rule',
  rule: 'a built-in rule',
  'small-send': `a small send (${'≤'}200 to a person is treated as groceries)`,
  'small-till': `a small payment (${'≤'}200 at a till is treated as groceries)`,
  fallback: 'nothing — it needs categorising',
};

// Categorising every transaction means running it past every rule, and render()
// is called for things that change nothing about the data - a time range, a sort,
// a filter. At ten thousand transactions that was most of the work on screen.
let decorateCache = { rev: -1, out: null };

function decorate(txns) {
  if (decorateCache.rev === store.revision() && decorateCache.out && decorateCache.n === txns.length) {
    return decorateCache.out;
  }
  const { userRules, nameRules, overrides, refundLinks } = store.getState();
  const byId = new Map(txns.map((t) => [t.id, t]));

  const base = txns.map((t) => {
    // A split is one movement assigned across several categories. It outranks both an
    // override and the rules: the parts drive every total (via categoryParts). The
    // row's own `category` is set to the biggest slice purely so labels and filters
    // have a real category to show — the truth is in `splits`.
    // Whole-transaction budget month (used for un-split payments pulled into another
    // month). For a split, each slice carries its own month; this is the fallback.
    const budgetMonth = store.budgetMonthFor(t.id);
    const splits = store.splitFor(t.id);
    if (splits && splits.length) {
      const primary = splits.reduce((a, b) => (b.amount > a.amount ? b : a));
      return { ...t, category: primary.category, splits, isSplit: true, budgetMonth, why: `split: ${splits.map((p) => p.category).join(' + ')}` };
    }
    // Carry WHY the category was chosen, not just what. When a category looks wrong
    // the only useful question is which rule decided it, and that used to be
    // unanswerable from the UI.
    if (overrides[t.id]) return { ...t, category: overrides[t.id], budgetMonth, why: 'set by hand on this row' };
    const c = categorise(t, userRules, nameRules);
    const detail =
      c.source === 'name'
        ? `name rule “${(specificMatch(t, nameRules) || {}).match || ''}”`
        : WHY[c.source] || c.source;
    return { ...t, category: c.category, budgetMonth, why: detail };
  });

  const notes = store.notes();
  for (const t of base) if (notes[t.id]) t.note = notes[t.id];

  // A refund pointed at a spend takes that spend's category and nets against it —
  // so a 3,000 fee refunded 2,500 reads as 500, which is what it cost.
  // Copies, not the base rows themselves: everything below writes onto these
  // (refund links, and the cash breakdown), and pocketNow() needs `base` left
  // exactly as filed. Sharing the objects meant a claim on money sent to be
  // drawn out was laid onto base too, and then applied a second time from
  // there - the pocket fell by twice the receipt.
  const decorated = new Map(base.map((t) => [t.id, { ...t }]));
  for (const [refundId, spendId] of Object.entries(refundLinks || {})) {
    const r = decorated.get(refundId);
    const s = decorated.get(spendId);
    if (!r || !s) continue; // one of them isn't loaded; leave the refund as it was
    r.category = s.category;
    r.isOffset = true;
    r.offsets = { id: s.id, counterparty: s.counterparty, amount: s.amount, date: s.date };
    r.why = `offsets ${s.counterparty} (${viz.fmt(s.amount)})`;
    s.offsetBy = (s.offsetBy || 0) + r.amount;
  }
  // Cash you have itemised re-labels the withdrawal it came out of. It is a
  // SPLIT rather than a transaction of its own because the money was already
  // counted as spending when it left the wallet - adding it again would count
  // the same 430 twice. See js/cash.js.
  const pocket = cash.allocate(base, store.cashRuns(), null, store.cashIn());
  for (const [id, parts] of pocket.splits) {
    const t = decorated.get(id);
    if (!t) continue;
    // A split you made by hand outranks this - unless the hand-made split is
    // the very thing that put the cash in your pocket, in which case these
    // parts are that split with its cash part broken down.
    if (t.isSplit && !pocket.hand.has(id)) continue;
    const primary = parts.reduce((a, b) => (b.amount > a.amount ? b : a));
    t.splits = parts;
    t.isSplit = true;
    t.isCashSplit = true;
    t.category = primary.category;
    t.why = `cash you itemised: ${parts.map((p) => p.category).join(' + ')}`;
  }

  // `base` is kept as well as `out`: it is the transactions as you filed them
  // - splits and overrides, but not the cash breakdown laid on top - which is
  // what the pocket has to be worked out from (see pocketNow).
  decorateCache = { rev: store.revision(), n: txns.length, out: [...decorated.values()], base };
  return decorateCache.out;
}

/** What should be in your pocket, from the transactions currently being read. */
function pocketNow() {
  const all = visible();
  // The cycle today falls in. Cash older than that was spent in a month that has
  // already closed, whatever it was spent on.
  const start = cycleStartOf(cycleMonthOf(isoDay(new Date())));
  // Worked out from the transactions as YOU filed them - with your splits and
  // overrides, since a Send Money filed under "Cash Withdrawal" is cash - but
  // not from decorate()'s finished rows, which already carry this calculation's
  // own answer. Fed its own output, allocate would find a hand-filed cash part
  // already broken down into what it bought, count only the unclaimed rest as
  // cash, and then have nowhere to place the same claims a second time.
  decorate(all);
  return cash.allocate(decorateCache.base || all, store.cashRuns(), start, store.cashIn());
}

// Which name rule actually won, for the explanation.
function specificMatch(txn, nameRules) {
  const hay = `${txn.counterparty || ''} ${txn.account || ''}`.toLowerCase();
  return [...nameRules]
    .sort((a, b) => (b.match || '').length - (a.match || '').length)
    .find((r) => r.match && hay.includes(r.match.toLowerCase()));
}

function inRange(txns) {
  if (state.range === 'all') return txns;
  const days = parseInt(state.range, 10);
  const cutoff = Date.now() - days * 86400000;
  return txns.filter((t) => t.date && new Date(t.date).getTime() >= cutoff);
}

/**
 * Everything the app is currently looking at.
 *
 * Not everything on file: see DEFAULT_WINDOW_MONTHS. The cut is made here, once,
 * before anything is categorised or counted, so every panel, chart, badge and
 * total below is working on the same, smaller set.
 */
function visible() {
  const all = store.allTransactions();
  const cutoff = windowStart();
  if (!cutoff) return all.filter((t) => t.date);
  return all.filter((t) => t.date && t.date >= cutoff);
}

/**
 * Says so when a save failed.
 *
 * A failed save is invisible by nature: the app carries on from memory and
 * looks perfectly healthy until it is closed, at which point the work is gone.
 * It has to be said on the screen, every render, until it stops being true.
 */
function warnAboutStorage() {
  const box = $('#window-warning');
  if (!box || !store.saveFailed) return;
  box.innerHTML = `<p><b>This phone would not save the last change.</b>
    ${escapeHtml(store.saveFailed)}. Nothing is lost while the app is open, but
    it will be when it closes. Reading fewer months in Data &amp; sync, or
    removing undated rows, frees space.</p>
    <div class="row"><button type="button" class="primary" data-go="data">Open Data &amp; sync</button></div>`;
  wireViewLinks(box);
}

/**
 * Says so when the window is hiding everything.
 *
 * A home screen of zeros looks exactly like a broken one, and the difference
 * matters: an app that has nothing and an app that is holding six thousand
 * transactions it has been told not to read are different problems with
 * different fixes. So it names the gap and offers both fixes.
 */
function warnAboutWindow(visibleTxns) {
  const box = $('#window-warning');
  if (!box) return;
  const onFile = store.allTransactions();
  const cutoff = windowStart();
  if (visibleTxns.length || !onFile.length || !cutoff) {
    box.innerHTML = '';
    return;
  }
  const dates = onFile.map((t) => t.date).filter(Boolean).sort();
  const newest = dates.at(-1);
  const undated = onFile.length - dates.length;
  const full = (iso) =>
    new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  box.innerHTML = `<p><b>Nothing to show since ${escapeHtml(full(cutoff))}.</b>
    ${onFile.length.toLocaleString('en-GB')} transactions are on file. ${undated ? `${undated.toLocaleString('en-GB')} of them carry no date and can never be placed in a month. ` : ''}${newest ? 'The newest dated one is from' : ''}
    ${newest ? `${escapeHtml(full(newest))} — so none of them fall inside the window.` : ''}</p>
    <div class="row">
      <button type="button" class="primary" data-go="intake">Read my messages again</button>
      <button type="button" class="ghost" data-go="data">Change the window</button>
    </div>`;
  wireViewLinks(box);
}

/** The first day the app reads, as an ISO date, or null for everything on file. */
function windowStart() {
  const s = store.settings();
  // A fixed date wins over a rolling count: it is the one that stays put.
  if (s.windowFrom) return `${s.windowFrom}T00:00:00.000Z`;
  const months = s.windowMonths ?? 0;
  if (!months) return null;
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  return from.toISOString();
}

function render() {
  const all = decorate(visible());
  const txns = inRange(all);
  warnAboutWindow(all);
  warnAboutStorage();

  const s = viz.summarise(txns);
  $('#kpi-spend').textContent = viz.fmt(s.realSpend);
  $('#kpi-income').textContent = viz.fmt(s.income);
  $('#kpi-fees').textContent = viz.fmt(s.fees);
  $('#kpi-transfers').textContent = viz.fmt(s.transfers);
  $('#kpi-count').textContent = txns.length;

  const net = s.income - s.realSpend;
  const netEl = $('#kpi-net');
  netEl.textContent = (net < 0 ? '−' : '+') + viz.fmt(Math.abs(net));
  netEl.classList.toggle('neg', net < 0);

  // One colour system for both: the ring and the bars under it are the same
  // categories, so they had better not be the same money in different colours.
  const cats = viz.byCategory(txns);
  const ringRows = viz.donutRows(cats);
  const slots = store.chartSlots(ringRows.map((r) => r.category));
  const slotOf = (c) => slots[c] ?? 7;
  // Minted already has this ring at the top of the home screen, so down here
  // it is the ranked list alone: one ring per screen.
  viz.renderDonut($('#chart-ring'), ringRows, slotOf, {
    label: 'spent this cycle',
    ring: lookNow() !== 'minted',
  });
  viz.renderCategoryBars($('#chart-categories'), cats, slotOf);
  wireDrill($('#chart-ring'));
  wireDrill($('#chart-categories'));
  const t = viz.overTime(txns);
  viz.renderTrend($('#chart-trend'), t.buckets, t.grain);
  viz.renderMerchants($('#table-merchants'), viz.byMerchant(txns));
  wireDrill($('#table-merchants'));
  renderHome(all);
  renderMonthly(all);
  renderRefunds(all);
  renderBudget(all);
  renderTrack(all);
  renderRecurring(all);
  renderBalance(all);
  renderFuliza(all);

  refreshCategoryFilter(txns);
  refreshAccountFilter(txns);
  // Debts read the whole ledger, not the selected range: what you owe doesn't
  // change because you're looking at last month.
  renderDebts(all);
  // The cycle today falls in, so "repaid this cycle" means the same month the
  // home screen's figures do.
  renderLoanActivity(all, cycleMonthOf(isoDay(new Date())));
  renderTriage(txns);

  // Cross-account check. Only shown once both accounts are actually present —
  // otherwise there is nothing to reconcile and the panel would be noise.
  const hasBoth =
    all.some((t) => (t.accountSource || 'mpesa') !== 'mpesa') && all.some((t) => (t.accountSource || 'mpesa') === 'mpesa');
  $('#recon-card').hidden = !hasBoth;
  if (hasBoth) {
    const r = reconcileAccounts(all);
    viz.renderReconcile($('#recon'), r);
    // An unmatched movement is the thing you'd want to know about without opening it.
    setBadge(
      '#recon-badge',
      r.checked ? `${r.matched.length} matched${r.unmatchedBank.length ? ` · ${r.unmatchedBank.length} unmatched` : ''}` : '',
      r.checked && r.unmatchedBank.length > 0
    );
  }

  const debt = viz.byCategory(txns, CLASSES.TRANSFER);
  $('#transfers-note').textContent = debt.length
    ? `Excluded from "spent": ${debt.map((d) => `${d.category} ${viz.fmt(d.total)}`).join(' · ')}`
    : '';

  // The charts always show the whole range; only the table below is filtered, so
  // narrowing to one person never silently rewrites the totals above.
  const rows = viz.sortTxns(applyFilters(txns), state.sort);
  const filtered = rows.length !== txns.length;
  // The total of what is actually listed. Without it a filtered list is a
  // claim you cannot check, and checking it was the whole point of opening it.
  // Through categoryParts, so a split row contributes only the slice that
  // matched. A 6,000 withdrawal with 2,864 of it filed as Groceries belongs in
  // a Groceries list for 2,864, which is what the figure that opened it said.
  const wanted = (p) => {
    if (state.drillCats) return state.drillCats.includes(p.category);
    if (state.catFilter !== 'all') return p.category === state.catFilter;
    return true;
  };
  const parts = rows.flatMap(categoryParts).filter(wanted);
  const outOf = parts.filter((t) => t.direction === 'Out').reduce((a, t) => a + t.amount, 0);
  const inOf = parts.filter((t) => t.direction === 'In').reduce((a, t) => a + t.amount, 0);
  const sums = [outOf ? `${viz.fmt(outOf)} out` : '', inOf ? `${viz.fmt(inOf)} in` : '']
    .filter(Boolean)
    .join(' \u00b7 ');
  $('#filter-count').textContent =
    (filtered ? `${rows.length} of ${txns.length}` : `${txns.length} transactions`) +
    (sums ? ` \u00b7 ${sums}` : '');

  // Categorising row by row here is the slow way round: ninety rows are usually
  // twenty people, and one pick on a name moves all of that person's at once.
  // The screen that does it existed already and was three taps away, which is
  // the same as not existing.
  const nudge = $('#txn-nudge');
  if (nudge) {
    const uncat = rows.filter((t) => t.category === 'Uncategorised');
    const names = new Set(uncat.map((t) => personName(t.counterparty)).filter(Boolean));
    const worth = uncat.length >= 6 && names.size < uncat.length;
    nudge.hidden = !worth;
    if (worth) {
      nudge.innerHTML =
        `<span>${uncat.length} uncategorised rows here — but only <strong>${names.size} people</strong>. ` +
        `Doing it by name sets every row of theirs at once.</span>` +
        `<button class="primary" type="button" data-go="triage">Do it by name</button>`;
      wireViewLinks(nudge);
    }
  }
  setBadge('#txn-badge', filtered ? `${rows.length} of ${txns.length}` : `${txns.length}`);

  // A drill-down must be obviously undoable, or it looks like the app lost your data.
  const chip = $('#drill-chip');
  const bits = [];
  if (state.drillMonth) bits.push(monthLabel(state.drillMonth));
  if (state.drillClass === 'spending') bits.push('spending only');
  if (state.drillFrom || state.drillTo) {
    bits.push(
      state.drillFrom === state.drillTo
        ? shortDate(state.drillFrom)
        : `${shortDate(state.drillFrom || '')} \u2013 ${shortDate(state.drillTo || '')}`
    );
  }
  if (state.catFilter !== 'all') bits.push(state.catFilter);
  if (state.drillCats) {
    const n = state.drillCats.length;
    bits.push(`${state.drillCatsLabel || viz.REST_LABEL} (${n} categor${n === 1 ? 'y' : 'ies'})`);
  }
  if (state.search) bits.push(`“${state.search}”`);
  if (state.dirFilter !== 'all') bits.push(state.dirFilter === 'Out' ? 'out only' : 'in only');
  if (state.acctFilter !== 'all') bits.push(state.acctFilter === 'bank' ? 'bank' : 'M-PESA');
  chip.hidden = bits.length === 0;
  if (bits.length) {
    // A list opened from a budget line is usually being read to decide whether
    // the line is right, so the way to change it belongs here, not three taps
    // away behind the back button.
    const toBudget = state.drillBudget
      ? `<button id="drill-budget" class="ghost">Adjust budget</button>`
      : '';
    chip.innerHTML =
      `<span>${bits.map(escapeHtml).join(' · ')}</span>${toBudget}<button id="drill-clear">Clear</button>`;
  }
  if (bits.length && $('#drill-budget')) {
    $('#drill-budget').addEventListener('click', () => {
      const id = state.drillBudget;
      showView('budget');
      // Put it in front of you and say which one, rather than leaving you to
      // find the line again on a screen of them.
      // After the view has drawn AND after the render it triggers: asking on
      // the next frame found the table still holding its previous rows.
      setTimeout(() => {
        const row = document.querySelector(`#budget [data-budget-row="${id}"]`);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          row.classList.add('just-came-from');
          setTimeout(() => row.classList.remove('just-came-from'), 1600);
        }
      }, 60);
    });
  }
  if (bits.length)
    $('#drill-clear').addEventListener('click', () => {
      state.drillMonth = null;
      state.drillFrom = null;
      state.drillTo = null;
      state.drillClass = null;
      state.drillCats = null;
      state.drillBudget = null;
      state.catFilter = 'all';
      state.search = '';
      state.dirFilter = 'all';
      state.acctFilter = 'all';
      $('#search').value = '';
      render();
    });

  viz.renderTable(
    $('#table-txns'),
    rows.slice(0, state.txnLimit),
    (id, cat) => {
      // A pass-through or an internal transfer is true of this payment only — making
      // it a rule for the sender would misfile everything they send you afterwards.
      const oneOff = ONE_OFF_CATEGORIES.has(cat);
      const { applied, name } = store.setCategory(id, cat, !oneOff, personName);
      render();
      renderNameRules();
      toast(
        name
          ? `“${name}” → ${cat}. ${applied} transaction${applied === 1 ? '' : 's'} follow, past and future.`
          : oneOff
            ? `${cat} — this transaction only, no rule made.`
            : `Recategorised.`
      );
    },
    state.sort,
    (key) => {
      // Same column toggles direction; a new column starts descending, which is
      // what you want for amounts and dates alike.
      state.sort =
        state.sort.key === key
          ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'desc' };
      state.txnLimit = 150;
      render();
    },
    all.length,
    (id) => openSplitEditor(all.find((t) => t.id === id)),
    {
      shown: Math.min(state.txnLimit, rows.length),
      total: rows.length,
      onMore: () => {
        state.txnLimit += 150;
        render();
      },
    },
    (id, text) => {
      store.setNote(id, text);
      render();
    },
  );
}

// Split one transaction across categories — one movement, several intents (one send
// covering both the househelp and the shopping). A small modal, because the parts have to
// reconcile to the transaction's amount before it can be saved.
function openSplitEditor(txn) {
  if (!txn) return;
  const cats = Object.keys(CATEGORIES);
  const existing = store.splitFor(txn.id);
  // Seed with the current split, or a two-part start: the whole amount on its current
  // category, plus an empty second part to move some of it into.
  let parts = existing
    ? existing.map((p) => ({ ...p }))
    : [
        { category: txn.category, amount: txn.amount },
        { category: cats.find((c) => c !== txn.category) || 'Groceries', amount: 0 },
      ];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const close = () => overlay.remove();
  const catOptions = (sel) => cats.map((c) => `<option${c === sel ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  const remainderText = (rem) => (rem >= 0 ? `${viz.fmt(rem)} left to assign` : `${viz.fmt(-rem)} over`);

  const draw = () => {
    const sum = parts.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    const remaining = Math.round((txn.amount - sum) * 100) / 100;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Split transaction">
        <h3>Split this transaction</h3>
        <p class="dim small">${escapeHtml(String(txn.counterparty || '—'))} · ${viz.fmt(txn.amount)} · ${shortDate(txn.date)}</p>
        <div class="split-parts">
          ${parts
            .map(
              (p, i) => `<div class="split-part">
                <select class="split-cat" data-i="${i}" aria-label="Category for part ${i + 1}">${catOptions(p.category)}</select>
                <input class="split-amt" data-i="${i}" type="number" min="0" step="100" value="${p.amount}" aria-label="Amount for part ${i + 1}">
                ${parts.length > 2 ? `<button class="link-btn" data-rm="${i}" title="Remove part">✕</button>` : '<span class="split-rm-spacer"></span>'}
              </div>`
            )
            .join('')}
        </div>
        <div class="split-foot">
          <button type="button" class="ghost" id="split-add">+ Add part</button>
          <span class="split-rem ${Math.abs(remaining) > 1 ? 'neg' : 'pos'}">${remainderText(remaining)}</span>
        </div>
        ${txn.type !== 'Withdrawal' && parts.some((p) => p.category === cash.UNCLAIMED_CATEGORY)
          ? `<p class="hint split-hint">The <b>Cash Withdrawal</b> part counts as cash in your pocket from ${shortDate(txn.date)} —
             money sent to be drawn out and handed to you. Itemise it on the Cash page like any other withdrawal.</p>`
          : ''}
        <div class="modal-actions">
          ${existing ? '<button type="button" class="ghost" id="split-remove">Remove split</button>' : ''}
          <button type="button" class="ghost" id="split-cancel">Cancel</button>
          <button type="button" id="split-save">Save split</button>
        </div>
      </div>`;

    overlay.querySelectorAll('.split-cat').forEach((s) =>
      s.addEventListener('change', () => {
        parts[+s.dataset.i].category = s.value;
        draw();
      })
    );
    overlay.querySelectorAll('.split-amt').forEach((inp) =>
      inp.addEventListener('input', () => {
        parts[+inp.dataset.i].amount = Number(inp.value) || 0;
        const rem = Math.round((txn.amount - parts.reduce((a, p) => a + (Number(p.amount) || 0), 0)) * 100) / 100;
        const el = overlay.querySelector('.split-rem');
        el.textContent = remainderText(rem);
        el.classList.toggle('neg', Math.abs(rem) > 1);
        el.classList.toggle('pos', Math.abs(rem) <= 1);
      })
    );
    overlay.querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        parts.splice(+b.dataset.rm, 1);
        draw();
      })
    );
    overlay.querySelector('#split-add').addEventListener('click', () => {
      const rem = Math.round((txn.amount - parts.reduce((a, p) => a + (Number(p.amount) || 0), 0)) * 100) / 100;
      parts.push({ category: cats[0], amount: Math.max(0, rem) });
      draw();
    });
    overlay.querySelector('#split-cancel').addEventListener('click', close);
    const rm = overlay.querySelector('#split-remove');
    if (rm)
      rm.addEventListener('click', () => {
        store.clearSplit(txn.id);
        close();
        render();
        toast('Split removed.');
      });
    overlay.querySelector('#split-save').addEventListener('click', () => {
      const res = store.setSplit(txn.id, parts);
      if (!res.ok) {
        toast(res.error);
        return;
      }
      close();
      render();
      toast('Split saved.');
    });
  };

  draw();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onEsc);
    }
  });
  document.body.appendChild(overlay);
}

// Say which month a pay funds. Salary lands through TerraPay in several chunks, so the
// picker offers whole pay RUNS — assigning one moves every chunk together, which is the
// only way it makes sense: they're one payment that M-PESA had to split up.
function openPayAssign(month) {
  // Recomputed on every draw, not captured once: assigning a run changes where it
  // counts, and a stale snapshot would keep showing the month it used to fund.
  let all = [];
  let runs = [];
  const refresh = () => {
    all = decorate(visible());
    runs = salaryRuns(all);
  };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };

  // Where a run currently counts. Asked through the SAME resolver the budget uses —
  // a local guess here (say, the month the last chunk landed in) would label a run
  // "funds June" while the budget was counting it in July.
  const runMonth = (run) => {
    const t = all.find((x) => x.id === run.ids[0]);
    return t ? monthResolver(all)(t) : (run.last || '').slice(0, 7);
  };

  const draw = () => {
    refresh();
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Assign a pay to a month">
        <h3>Which pay funds ${escapeHtml(monthLabel(month))}?</h3>
        <p class="dim small">Your salary arrives from TerraPay in chunks — M-PESA won't take it in one go — so each row below is one payday, chunks added up. Assigning it moves every chunk together. Statement dates don't change.</p>
        <div class="pick-list">${
          runs.length
            ? runs
                .map((r, i) => {
                  const here = runMonth(r) === month;
                  const span =
                    r.first.slice(0, 10) === r.last.slice(0, 10)
                      ? shortDate(r.last)
                      : `${shortDate(r.first)} – ${shortDate(r.last)}`;
                  return `<button type="button" class="pick-row${here ? ' is-linked' : ''}" data-run="${i}">
                    <span class="dim small">${span}</span>
                    <strong>${viz.fmt(r.total)}</strong>
                    <span class="ellip dim small">${r.count} chunk${r.count === 1 ? '' : 's'}</span>
                    <span class="dim small">${here ? '✓ funds this month' : `now: ${monthLabel(runMonth(r))}`}</span>
                  </button>`;
                })
                .join('')
            : '<p class="hint">No TerraPay salary found yet. Import a statement that covers a payday.</p>'
        }</div>
        <div class="modal-actions"><button type="button" class="ghost" id="pay-close">Close</button></div>
      </div>`;

    overlay.querySelectorAll('button[data-run]').forEach((b) =>
      b.addEventListener('click', () => {
        const run = runs[+b.dataset.run];
        const here = runMonth(run) === month;
        // Clicking the run that already funds this month releases it back to its own date.
        for (const id of run.ids) store.assignBudgetMonth(id, [], here ? null : month);
        toast(
          here
            ? `That pay goes back to ${monthLabel((run.last || '').slice(0, 7))}.`
            : `${viz.fmt(run.total)} now funds ${monthLabel(month)}.`
        );
        render();
        draw();
      })
    );
    overlay.querySelector('#pay-close').addEventListener('click', close);
  };

  draw();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

// Work FROM a budget line: pick a payment (from another month) and count it toward
// this line for the month on screen — an end-of-June househelp salary pulled into
// July. Only the slice that belongs to this line moves; the statement date stays put.
function openBudgetAssign(line, month) {
  const cats = new Set(line.categories);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };

  const partsOf = (t) => (t.splits && t.splits.length ? t.splits.map((p) => p.category) : [t.category]);
  // Where a slice currently counts: its own month, else the whole-txn assignment, else date.
  const sliceMonth = (t, cat) => {
    const p = (t.splits || []).find((x) => x.category === cat);
    return (p && p.month) || t.budgetMonth || (t.date || '').slice(0, 7);
  };
  const lineAmount = (t, hits) =>
    t.splits && t.splits.length
      ? t.splits.filter((p) => hits.includes(p.category)).reduce((a, p) => a + p.amount, 0)
      : t.amount;

  let relevant = [];
  const recompute = () => {
    relevant = decorate(visible())
      .filter((t) => t.direction === 'Out')
      .map((t) => ({ t, hits: partsOf(t).filter((c) => cats.has(c)) }))
      .filter((x) => x.hits.length);
  };

  let query = '';
  const row = ({ t, hits }, action) => `
    <button type="button" class="pick-row" data-${action}="${escapeHtml(t.id)}">
      <span class="dim small">${shortDate(t.date)}</span>
      <strong>${viz.fmt(lineAmount(t, hits))}</strong>
      <span class="ellip">${escapeHtml(String(t.counterparty || '—').slice(0, 26))}</span>
      <span class="dim small">${escapeHtml(hits.join(', '))}</span>
    </button>`;

  const updateList = () => {
    const q = query.trim().toLowerCase();
    const assigned = relevant.filter(
      ({ t, hits }) => hits.some((c) => sliceMonth(t, c) === month) && (t.date || '').slice(0, 7) !== month
    );
    const pool = relevant
      .filter(({ t, hits }) => hits.some((c) => sliceMonth(t, c) !== month))
      .filter(({ t }) => !q || `${t.counterparty || ''} ${t.receipt || ''} ${t.type || ''}`.toLowerCase().includes(q))
      .sort((a, b) => (a.t.date < b.t.date ? 1 : -1))
      .slice(0, 40);

    overlay.querySelector('.assign-here-box').innerHTML = assigned.length
      ? `<div class="dim small budget-outside-head">Pulled into ${escapeHtml(monthLabel(month))} — click to remove</div>${assigned
          .map((x) => row(x, 'unassign'))
          .join('')}`
      : '';
    overlay.querySelector('#assign-pool').innerHTML = pool.length
      ? pool.map((x) => row(x, 'assign')).join('')
      : '<p class="hint">No payments in other months belong to this line.</p>';

    overlay.querySelectorAll('button[data-assign]').forEach((b) =>
      b.addEventListener('click', () => {
        const res = store.assignBudgetMonth(b.dataset.assign, line.categories, month);
        if (!res.ok) return toast(res.error);
        toast(`Added to ${line.label} for ${monthLabel(month)}.`);
        render();
        recompute();
        updateList();
      })
    );
    overlay.querySelectorAll('button[data-unassign]').forEach((b) =>
      b.addEventListener('click', () => {
        store.assignBudgetMonth(b.dataset.unassign, line.categories, null);
        toast('Removed from this month.');
        render();
        recompute();
        updateList();
      })
    );
  };

  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Assign a payment to a budget line">
      <h3>Count a payment toward ${escapeHtml(line.label)}</h3>
      <p class="dim small">for ${escapeHtml(monthLabel(month))} — pick a payment from another month and it counts on this line, without moving its statement date.</p>
      <div class="assign-here-box"></div>
      <input type="search" class="pick-search" id="assign-search" placeholder="Search a payment to pull in…">
      <div class="pick-list" id="assign-pool"></div>
      <div class="modal-actions"><button type="button" class="ghost" id="assign-close">Close</button></div>
    </div>`;
  overlay.querySelector('#assign-search').addEventListener('input', (e) => {
    query = e.target.value;
    updateList();
  });
  overlay.querySelector('#assign-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onEsc);

  recompute();
  updateList();
  document.body.appendChild(overlay);
}

function renderRefunds(all) {
  // Anything the rules called a refund, plus anything already pointed at a spend.
  const refunds = all.filter((t) => t.direction === 'In' && (t.isOffset || t.category === 'Refunds'));
  const card = $('#refunds-card');
  card.hidden = refunds.length === 0;
  if (!refunds.length) return;

  refunds.sort((a, b) => (a.date < b.date ? 1 : -1));
  const linked = refunds.filter((t) => t.isOffset);
  const loose = refunds.filter((t) => !t.isOffset);
  const total = refunds.reduce((a, t) => a + t.amount, 0);
  setBadge('#refunds-badge', `${viz.fmt(total)} back${loose.length ? ` · ${loose.length} unlinked` : ''}`, loose.length > 0);

  $('#refunds').innerHTML = `
    <table class="mini">
      <thead><tr><th>Refund</th><th class="num">Amount</th><th>Offsets</th><th class="num">Net cost</th><th></th></tr></thead>
      <tbody>${refunds
        .map((t) => {
          const net = t.offsets ? t.offsets.amount - t.amount : null;
          return `<tr>
          <td>
            <strong>${escapeHtml(String(t.counterparty || '').slice(0, 30))}</strong>
            <div class="dim small">${shortDate(t.date)}${t.receipt ? ` · ${escapeHtml(t.receipt)}` : ''}</div>
          </td>
          <td class="num in">+${viz.fmt(t.amount)}</td>
          <td>${
            t.offsets
              ? `<span class="dim">${escapeHtml(String(t.offsets.counterparty).slice(0, 26))} · ${viz.fmt(t.offsets.amount)} on ${shortDate(t.offsets.date)}</span>`
              : `<button class="btn-quiet" data-off="${escapeHtml(t.id)}">Offset against…</button>`
          }</td>
          <td class="num ${net !== null ? (net > 0 ? '' : 'in') : 'dim'}">${net !== null ? viz.fmt(net) : '—'}</td>
          <td class="num">${
            t.offsets ? `<button class="link-btn" data-unoff="${escapeHtml(t.id)}" title="Unlink">✕</button>` : ''
          }</td>
        </tr>
        <tr class="off-picker-row" data-row="${escapeHtml(t.id)}" hidden><td colspan="5">
          <div class="pick-box" style="margin:0">
            <input type="search" class="pick-search" data-offsearch="${escapeHtml(t.id)}" placeholder="Search the payment this refunds…">
            <div class="pick-list" data-offlist="${escapeHtml(t.id)}"></div>
            <button type="button" class="ghost pick-close" data-offcancel="${escapeHtml(t.id)}">Close</button>
          </div>
        </td></tr>`;
        })
        .join('')}</tbody>
    </table>
    ${
      linked.length
        ? `<p class="hint note">${linked.length} refund(s) linked — those reduce their original category instead of counting as income.</p>`
        : ''
    }`;

  const drawOff = (id) => {
    const q = $(`input[data-offsearch="${CSS.escape(id)}"]`).value;
    const hits = store.offsetCandidates(id, { query: q });
    const box = $(`div[data-offlist="${CSS.escape(id)}"]`);
    box.innerHTML = hits.length
      ? hits
          .map(
            (t) => `<button type="button" class="pick-row" data-dolink="${escapeHtml(id)}|${escapeHtml(t.id)}">
        <span class="dim small">${shortDate(t.date)}</span>
        <strong>${viz.fmt(t.amount)}</strong>
        <span class="ellip">${escapeHtml(String(t.counterparty || '—').slice(0, 30))}</span>
        <span class="dim small">${escapeHtml(t.receipt || '')}</span>
      </button>`
          )
          .join('')
      : '<p class="hint">Nothing matches that search.</p>';

    box.querySelectorAll('button[data-dolink]').forEach((b) =>
      b.addEventListener('click', () => {
        const [rid, sid] = b.dataset.dolink.split('|');
        const res = store.linkRefund(rid, sid);
        if (!res.ok) {
          toast(res.error, 'warn');
          return;
        }
        render();
        const net = res.spend.amount - res.refund.amount;
        toast(`Linked. ${res.spend.counterparty} cost you ${viz.fmt(net)} after the refund.`);
      })
    );
  };

  $('#refunds')
    .querySelectorAll('button[data-off]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.off;
        const row = $(`tr[data-row="${CSS.escape(id)}"]`);
        const opening = row.hidden;
        $('#refunds')
          .querySelectorAll('.off-picker-row')
          .forEach((r) => (r.hidden = true));
        row.hidden = !opening;
        if (opening) {
          drawOff(id);
          row.querySelector('input').focus();
        }
      })
    );

  $('#refunds')
    .querySelectorAll('input[data-offsearch]')
    .forEach((inp) => {
      let t;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => drawOff(inp.dataset.offsearch), 140);
      });
    });

  $('#refunds')
    .querySelectorAll('button[data-offcancel]')
    .forEach((b) => b.addEventListener('click', () => ($(`tr[data-row="${CSS.escape(b.dataset.offcancel)}"]`).hidden = true)));

  $('#refunds')
    .querySelectorAll('button[data-unoff]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        store.unlinkRefund(b.dataset.unoff);
        render();
        toast('Unlinked — it counts as money in again.');
      })
    );
}

function renderBudget(all) {
  const card = $('#budget-card');
  if (!state.month) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const { report, budgeted, spent, left, outside, outsideItems, funded, cycleStart } = budgetReport(
    store.budgets(),
    all,
    state.month
  );
  setBadge('#budget-badge', `${viz.fmt(spent)} of ${viz.fmt(budgeted)}`, spent > budgeted);

  $('#budget').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Spent against budget</span>
        <span class="kpi-value ${spent > budgeted ? 'neg' : ''}">${viz.fmt(spent)}</span>
        <span class="kpi-note">of ${viz.fmt(budgeted)} budgeted</span>
      </div>
      <div class="kpi"><span class="kpi-label">${left >= 0 ? 'Left' : 'Over'}</span><span class="kpi-value ${left < 0 ? 'neg' : 'pos'}">${viz.fmt(Math.abs(left))}</span></div>
      <div class="kpi"><span class="kpi-label">Outside any budget</span><span class="kpi-value">${viz.fmt(outside)}</span><span class="kpi-note">not covered by a line below</span></div>
      <div class="kpi">
        <span class="kpi-label">Pay funding this month</span>
        <span class="kpi-value ${funded > 0 ? 'pos' : ''}">${viz.fmt(funded)}</span>
        <span class="kpi-note"><button class="budget-assign" id="assign-pay">${
          funded > 0 ? 'change which pay' : '＋ assign a pay'
        }</button></span>
      </div>
    </div>
    ${
      cycleStart
        ? `<p class="hint note">This month runs from payday — <strong>${shortDate(cycleStart)}</strong> onward counts here, not from the 1st. Everything spent after that pay is spending this month's money.</p>`
        : ''
    }
    ${
      /* The arithmetic, stated. Two panels showing different totals for the same month
         reads as a bug even when both are right, so the tie-back to the monthly
         report's "spent" is spelled out rather than left to be worked out. */
      outside > 0
        ? `<p class="hint note"><strong>${viz.fmt(spent + outside)}</strong> went out this month: ${viz.fmt(spent)} on the lines below + ${viz.fmt(outside)} no line covers. That total is what the monthly report shows as spent.</p>`
        : ''
    }
    <table class="mini budget-table">
      <thead><tr><th>Line</th><th class="num">Budget</th><th class="num">Spent</th><th>Progress</th><th class="num">Left</th></tr></thead>
      <tbody>${report
        .map(
          (r) => `<tr data-budget-row="${escapeHtml(r.id)}">
        <td>
          <strong>${escapeHtml(r.label)}</strong>
          <div class="dim small">${
            r.unmapped
              ? '<span class="shadow">no category mapped — always 0</span>'
              : r.categories
                  .map(
                    (c) =>
                      `<span class="cat-chip" data-drill-cat="${escapeHtml(c)}" role="button" tabindex="0" title="Show ${escapeHtml(c)} transactions this month">${escapeHtml(c)}</span>`
                  )
                  .join(' ')
          }</div>
          ${
            r.unmapped
              ? ''
              : `<button class="budget-assign" data-assign="${r.id}" title="Count a payment from another month toward this line">＋ pull in a payment</button>`
          }
        </td>
        <td class="num"><input class="budget-input" type="number" min="0" step="500" value="${r.amount}" data-budget="${r.id}" aria-label="Budget for ${escapeHtml(r.label)}"></td>
        <td class="num ${r.over ? 'neg' : ''}">${viz.fmt(r.spent)}</td>
        <td class="debt-bar-cell">
          <div class="meter"><div class="meter-fill" style="width:${Math.min(100, r.pct * 100)}%;${
            r.over ? 'background:var(--critical)' : ''
          }"></div></div>
        </td>
        <td class="num ${r.left < 0 ? 'neg' : 'dim'}">${r.left < 0 ? '−' : ''}${viz.fmt(Math.abs(r.left))}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>
    ${
      outsideItems && outsideItems.length
        ? `<div class="budget-outside">
             <div class="dim small budget-outside-head">Spending not on any budget line — ${viz.fmt(outside)} total</div>
             <table class="mini">
               <tbody>${outsideItems
                 .map(
                   (o) => `<tr>
                     <td><span class="cat-chip" data-drill-cat="${escapeHtml(o.category)}" role="button" tabindex="0" title="Show ${escapeHtml(o.category)} transactions this month">${escapeHtml(o.category)}</span>${
                     o.category === 'Uncategorised'
                       ? ' <span class="shadow">— name these in People to place them</span>'
                       : !isBuiltInCategory(o.category)
                         ? ' <span class="shadow">— custom category, add it to a line above</span>'
                         : ''
                   }</td>
                     <td class="num">${viz.fmt(o.amount)}</td>
                   </tr>`
                 )
                 .join('')}</tbody>
             </table>
           </div>`
        : ''
    }`;

  $('#budget')
    .querySelectorAll('input[data-budget]')
    .forEach((i) =>
      i.addEventListener('change', () => {
        store.setBudget(i.dataset.budget, i.value);
        render();
        toast('Budget updated.');
      })
    );

  // Every budget category is a question you can follow: click it to see the
  // transactions behind it, for the month the budget is showing.
  wireDrill($('#budget'), state.month);

  const payBtn = $('#assign-pay');
  if (payBtn) payBtn.addEventListener('click', () => openPayAssign(state.month));

  // "Pull in a payment" — assign a spend from another month to this line's month.
  $('#budget')
    .querySelectorAll('button[data-assign]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const line = report.find((r) => r.id === b.dataset.assign);
        if (line) openBudgetAssign(line, state.month);
      })
    );
}

function renderRecurring(all) {
  const found = findRecurring(all);
  const card = $('#recurring-card');
  card.hidden = found.length === 0;
  if (!found.length) return;

  const committed = committedMonthly(found);
  const stale = found.filter((r) => r.stale);
  setBadge('#recurring-badge', `${viz.fmt(committed)}/mo committed`, false);

  $('#recurring').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Committed monthly</span>
        <span class="kpi-value">${viz.fmt(committed)}</span>
        <span class="kpi-note">across ${found.length - stale.length} live commitments</span>
      </div>
      ${
        stale.length
          ? `<div class="kpi"><span class="kpi-label">Lapsed</span><span class="kpi-value">${stale.length}</span><span class="kpi-note">overdue by more than a cycle</span></div>`
          : ''
      }
    </div>
    <table class="mini">
      <thead><tr><th>Payment</th><th class="num">Typical</th><th>Cadence</th><th class="num">Per month</th><th class="num">Last</th><th class="num">Next due</th></tr></thead>
      <tbody>${found
        .map(
          (r) => `<tr class="drill${r.stale ? ' is-stale' : ''}" data-drill-name="${escapeHtml(r.name)}" tabindex="0">
        <td>
          <strong>${escapeHtml(r.name)}</strong>
          <div class="dim small">${escapeHtml(r.category)} · ${r.count}× · ${Math.round(r.confidence * 100)}% regular</div>
        </td>
        <td class="num">${viz.fmt(r.typical)}</td>
        <td class="dim">${r.cadence}</td>
        <td class="num">${viz.fmt(r.perMonth)}</td>
        <td class="num dim nowrap">${shortDate(r.last)}</td>
        <td class="num nowrap ${r.stale ? 'shadow' : 'dim'}">${r.stale ? 'lapsed' : shortDate(r.nextDue)}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>`;
  wireDrill($('#recurring'));
}

function renderBalance(all) {
  const accts = [...new Set(all.map((t) => t.accountSource || 'mpesa'))];
  const card = $('#balance-card');
  const any = all.some((t) => t.balance != null);
  card.hidden = !any;
  if (!any) return;

  if (!state.balAcct || !accts.includes(state.balAcct)) state.balAcct = accts.includes('mpesa') ? 'mpesa' : accts[0];
  const sel = $('#bal-acct');
  sel.innerHTML = accts
    .map((a) => `<option value="${a}"${a === state.balAcct ? ' selected' : ''}>${a === 'bank' ? 'Bank' : 'M-PESA'}</option>`)
    .join('');

  const series = balanceSeries(all, state.balAcct);
  const low = lowDays(series, 100);
  const latest = series.at(-1);
  setBadge(
    '#balance-badge',
    latest ? `${viz.fmt(latest.balance)} latest${low ? ` · ${low} days under 100` : ''}` : '',
    low > 0
  );
  viz.renderBalance($('#chart-balance'), series, state.balAcct);

  sel.addEventListener('change', () => {
    state.balAcct = sel.value;
    render();
  });
}

function renderFuliza(all) {
  const f = fulizaReport(all);
  const card = $('#fuliza-card');
  card.hidden = f.times === 0;
  if (!f.times) return;

  setBadge(
    '#fuliza-badge',
    `${f.outstanding > 0 ? `${viz.fmt(f.outstanding)} owed · ` : 'clear · '}${f.times} draws`,
    f.outstanding > 0
  );
  const maxMonth = Math.max(...f.byMonth.map((m) => m.amount), 1);

  $('#fuliza').innerHTML = `
    <p class="hint">Fuliza covers you when the wallet is short. Drawing on it isn't spending — it's borrowing — so it never counts toward your totals. It repays itself the moment money lands in your wallet, so the balance below is read straight from your statements' draws and repayments.</p>
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Still owed on Fuliza</span>
        <span class="kpi-value ${f.outstanding > 0 ? 'neg' : 'pos'}">${viz.fmt(f.outstanding)}</span>
        <span class="kpi-note">${f.outstanding > 0 ? 'drawn, not yet repaid' : 'cleared — every draw repaid'}</span>
      </div>
      <div class="kpi"><span class="kpi-label">Times short</span><span class="kpi-value">${f.times}</span><span class="kpi-note">${f.everyNDays ? `about every ${f.everyNDays.toFixed(1)} days` : ''}</span></div>
      <div class="kpi"><span class="kpi-label">Total drawn</span><span class="kpi-value">${viz.fmt(f.borrowed)}</span><span class="kpi-note">avg ${viz.fmt(f.avgDraw)}</span></div>
      <div class="kpi"><span class="kpi-label">Repaid</span><span class="kpi-value">${viz.fmt(f.repaid)}</span></div>
      <div class="kpi"><span class="kpi-label">Charges on those days</span><span class="kpi-value">${viz.fmt(f.feesOnDraws)}</span><span class="kpi-note">fees, not interest</span></div>
    </div>

    <h3 class="debt-group">How often, by month</h3>
    <div class="bars">${f.byMonth
      .map(
        (m) => `<div class="bar-row">
        <div class="bar-label">${escapeHtml(monthLabel(m.month))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(m.amount / maxMonth) * 100}%"></div></div>
        <div class="bar-value">${viz.fmt(m.amount)}<span class="bar-count">${m.count}×</span></div>
      </div>`
      )
      .join('')}</div>

    <h3 class="debt-group">What you were short for</h3>
    <table class="mini">
      <thead><tr><th>Category</th><th class="num">Funded by Fuliza</th><th class="num">Times</th></tr></thead>
      <tbody>${f.forWhat
        .map(
          (c) => `<tr class="drill" data-drill-cat="${escapeHtml(c.category)}" tabindex="0">
        <td>${escapeHtml(c.category)}</td><td class="num">${viz.fmt(c.total)}</td><td class="num dim">${c.count}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>
    <p class="hint note">I'm not quoting a cost of borrowing. Draws and repayments fall in different periods, so “repaid minus drawn” would mostly measure where the statement starts and stops, not what Fuliza charged you. The statement doesn't itemise Fuliza interest — the charges above are the fees on those same receipts, which is the closest honest figure.</p>`;

  wireDrill($('#fuliza'));
}

/**
 * Months you can select. Transaction dates alone aren't enough: pay received on 28 July
 * that funds AUGUST needs an August to assign it to, and August has no transactions
 * yet. So the list also carries every month something has been assigned to, plus one
 * month past the newest data — the month you're about to live in.
 */
function selectableMonths(all) {
  const set = new Set(monthsIn(all));
  for (const m of store.assignedBudgetMonths()) set.add(m);
  const newest = [...set].sort().at(-1);
  if (newest) set.add(nextMonth(newest));
  return [...set].sort().reverse();
}

/**
 * One budget line (or one category) across every month.
 *
 * The monthly report answers "how did this month compare with last"; this answers
 * "is this creeping up", which needs the whole run of months at once.
 *
 * Every figure comes from budgetReport, deliberately — that's the only way it agrees
 * with the Budget panel. A plain sum by transaction date would quietly disagree with
 * it for anything split across categories or assigned to a different month.
 */
function renderTrack(all) {
  const card = $('#track-card');
  const months = selectableMonths(all).slice().reverse(); // oldest → newest
  const budgets = store.budgets();
  if (months.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const lines = budgets.filter((b) => b.categories.length);
  const cats = [
    ...new Set(
      all
        .filter((t) => t.direction === 'Out')
        .flatMap((t) => (t.splits && t.splits.length ? t.splits.map((p) => p.category) : [t.category]))
    ),
  ]
    .filter((c) => classOf(c) === CLASSES.SPENDING)
    .sort();

  const valid = new Set([...lines.map((b) => `line:${b.id}`), ...cats.map((c) => `cat:${c}`)]);
  if (!state.track || !valid.has(state.track)) state.track = lines.length ? `line:${lines[0].id}` : `cat:${cats[0]}`;

  const sel = $('#track-sel');
  sel.innerHTML =
    `<optgroup label="Budget lines">${lines
      .map((b) => `<option value="line:${escapeHtml(b.id)}"${state.track === `line:${b.id}` ? ' selected' : ''}>${escapeHtml(b.label)}</option>`)
      .join('')}</optgroup>` +
    `<optgroup label="Single categories">${cats
      .map((c) => `<option value="cat:${escapeHtml(c)}"${state.track === `cat:${c}` ? ' selected' : ''}>${escapeHtml(c)}</option>`)
      .join('')}</optgroup>`;

  // A single category is measured by asking the budget engine about a one-line budget
  // containing just it — same code path, so the numbers can't drift apart.
  const isLine = state.track.startsWith('line:');
  const line = isLine ? lines.find((b) => `line:${b.id}` === state.track) : null;
  const cat = isLine ? null : state.track.slice(4);
  const probe = isLine ? budgets : [{ id: 'probe', label: cat, amount: 0, categories: [cat] }];
  const label = isLine ? line.label : cat;
  const covers = isLine ? line.categories : [cat];

  const full = months.map((m) => {
    const rep = budgetReport(probe, all, m);
    const row = isLine ? rep.report.find((r) => r.id === line.id) : rep.report[0];
    return { month: m, spent: row.spent, budget: row.amount, count: row.count };
  });

  // Months before this line ever saw a shilling say nothing — the data simply starts
  // sparse. Interior gaps stay: "nothing in April" is a real answer.
  const firstActive = full.findIndex((s) => s.count > 0);
  const series = firstActive > 0 ? full.slice(firstActive) : full;

  const spentMonths = series.filter((s) => s.count > 0);
  const avg = spentMonths.length ? spentMonths.reduce((a, s) => a + s.spent, 0) / spentMonths.length : 0;
  const peak = series.reduce((a, s) => (s.spent > a.spent ? s : a), series[0]);
  // The newest month with activity, not simply the last column — the list runs one
  // month ahead for budgeting, and "August: 0, down 100%" is noise, not news.
  const latest = spentMonths.length ? spentMonths[spentMonths.length - 1] : series[series.length - 1];
  const vsAvg = avg > 0 && latest.count > 0 ? (latest.spent - avg) / avg : null;
  const max = Math.max(...series.map((s) => Math.max(s.spent, s.budget)), 1);

  setBadge('#track-badge', `${label} · ${viz.fmt(avg)}/mo avg`);

  $('#track').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Average a month</span>
        <span class="kpi-value">${viz.fmt(avg)}</span>
        <span class="kpi-note">${spentMonths.length} month${spentMonths.length === 1 ? '' : 's'} with spending</span>
      </div>
      <div class="kpi"><span class="kpi-label">${escapeHtml(monthLabel(latest.month))}</span><span class="kpi-value">${viz.fmt(latest.spent)}</span><span class="kpi-note">${
        vsAvg === null ? '&nbsp;' : `${vsAvg >= 0 ? '↑' : '↓'} ${Math.abs(vsAvg * 100).toFixed(0)}% vs average`
      }</span></div>
      <div class="kpi"><span class="kpi-label">Highest</span><span class="kpi-value">${viz.fmt(peak.spent)}</span><span class="kpi-note">${escapeHtml(monthLabel(peak.month))}</span></div>
      <div class="kpi"><span class="kpi-label">Covers</span><span class="kpi-value" style="font-size:15px;line-height:1.3">${covers.map(escapeHtml).join('<br>')}</span></div>
    </div>

    <div class="bars" role="list">${series
      .map((s) => {
        const over = s.budget > 0 && s.spent > s.budget;
        // The budget shows as a notch on the track, so "over" is visible at a glance
        // rather than something you work out from two numbers.
        const notch =
          s.budget > 0
            ? `<div class="budget-notch" style="left:${Math.min(100, (s.budget / max) * 100)}%" title="Budget ${viz.fmt(s.budget)}"></div>`
            : '';
        return `<div class="bar-row track-row" data-track-month="${s.month}" role="listitem" tabindex="0" title="Show these transactions">
          <div class="bar-label">${escapeHtml(monthLabel(s.month))}</div>
          <div class="bar-track">${notch}<div class="bar-fill" style="width:${(s.spent / max) * 100}%${
            over ? ';background:var(--critical)' : ''
          }"></div></div>
          <div class="bar-value ${over ? 'neg' : ''}">${viz.fmt(s.spent)}${
            s.count ? `<span class="bar-count">${s.count}×</span>` : ''
          }</div>
        </div>`;
      })
      .join('')}</div>
    ${
      series.some((s) => s.budget > 0)
        ? '<p class="hint note">The notch on each bar is that month’s budget; a red bar went over it.</p>'
        : ''
    }`;

  sel.onchange = () => {
    state.track = sel.value;
    renderTrack(all);
  };

  // Click a month to see exactly what made it up — budget-month aware, so it matches
  // the bar rather than the calendar.
  $('#track')
    .querySelectorAll('[data-track-month]')
    .forEach((el) => {
      const go = () => {
        state.drillMonth = el.dataset.trackMonth;
        state.catFilter = covers.length === 1 ? covers[0] : 'all';
        state.search = '';
        state.dirFilter = 'Out';
        render();
        showView('txns');
        $('#table-txns').scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(`Showing ${label} in ${monthLabel(el.dataset.trackMonth)}.`);
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    });
}

function renderMonthly(all) {
  const months = selectableMonths(all);
  const card = $('#month-card');
  card.hidden = months.length === 0;
  if (!months.length) return;

  // The month you are LIVING in, not the newest one offered. The list always
  // carries one month beyond the data so a budget can be set ahead of time, and
  // defaulting to the newest opened the report on an empty future month.
  if (!state.month || !months.includes(state.month)) {
    const now = cycleMonthOf(isoDay(new Date()));
    state.month = months.includes(now) ? now : months[0];
  }

  const sel = $('#month-sel');
  sel.innerHTML = months.map((m) => `<option value="${m}"${m === state.month ? ' selected' : ''}>${monthLabel(m)}</option>`).join('');

  const { now, prev, prevKey, movers } = compareMonths(all, state.month);
  const hasPrev = prev.count > 0;
  $('#month-vs').textContent = hasPrev ? `compared with ${monthLabel(prevKey)}` : 'no earlier month to compare with';
  setBadge('#month-badge', `${monthLabel(state.month)} · ${viz.fmt(now.spent)} spent`);

  const delta = now.spent - prev.spent;
  const pct = prev.spent > 0 ? delta / prev.spent : null;
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '';

  // Everything spent on this month gets a comparison — ranking by size of CHANGE alone
  // filled the table with categories that had gone quiet while dropping the ones money
  // actually went to. Two days into a month, every category shows a big drop, so
  // "biggest movers" is a list of things that haven't happened yet.
  //
  // So: what you spent on, biggest first, always. Then the largest categories that have
  // gone quiet, which is real information early in a month ("rent hasn't gone out yet")
  // but must not crowd out the spending itself.
  const active = movers.filter((m) => m.now > 0).sort((a, b) => b.now - a.now);
  const quiet = movers
    .filter((m) => m.now === 0 && m.prev >= Math.max(500, prev.spent * 0.02))
    .sort((a, b) => b.prev - a.prev)
    .slice(0, 6);
  const material = [...active, ...quiet];

  $('#month-report').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Spent</span>
        <span class="kpi-value">${viz.fmt(now.spent)}</span>
        <span class="kpi-note">${
          hasPrev
            ? `${arrow} ${viz.fmt(Math.abs(delta))}${pct !== null ? ` (${(Math.abs(pct) * 100).toFixed(0)}%)` : ''} vs ${monthLabel(prevKey).split(' ')[0]}`
            : '&nbsp;'
        }</span>
      </div>
      <div class="kpi"><span class="kpi-label">Received</span><span class="kpi-value">${viz.fmt(now.income)}</span></div>
      <div class="kpi"><span class="kpi-label">Net</span><span class="kpi-value ${now.net < 0 ? 'neg' : 'pos'}">${
        now.net < 0 ? '−' : '+'
      }${viz.fmt(Math.abs(now.net))}</span></div>
      <div class="kpi"><span class="kpi-label">Fees</span><span class="kpi-value">${viz.fmt(now.fees)}</span></div>
      <div class="kpi"><span class="kpi-label">Transactions</span><span class="kpi-value">${now.count}</span></div>
    </div>

    ${
      hasPrev && material.length
        ? `<h3 class="debt-group">${escapeHtml(monthLabel(state.month).split(' ')[0])} vs ${escapeHtml(monthLabel(prevKey).split(' ')[0])}</h3>
           <table class="mini month-table">
             <thead><tr><th>Category</th><th class="num">${monthLabel(state.month).split(' ')[0]}</th><th class="num">${monthLabel(prevKey).split(' ')[0]}</th><th class="num">Change</th><th>Why</th></tr></thead>
             <tbody>${material.map((m) => moverRow(m, all)).join('')}</tbody>
           </table>`
        : ''
    }

    <h3 class="debt-group">Everything in ${escapeHtml(monthLabel(state.month))}</h3>
    <div class="bars" role="list">${
      now.categories.length
        ? now.categories
            .map((c, i) => {
              const max = now.categories[0].total;
              return `<div class="bar-row drill" data-drill-cat="${escapeHtml(c.category)}" role="listitem" tabindex="0"
                        title="Show these transactions">
                <div class="bar-label">${escapeHtml(c.category)}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${(c.total / max) * 100}%;background:${rampFor(i, now.categories.length)}"></div></div>
                <div class="bar-value">${viz.fmt(c.total)}<span class="bar-count">${c.count}×</span></div>
              </div>`;
            })
            .join('')
        : '<p class="empty">Nothing spent this month.</p>'
    }</div>`;

  sel.addEventListener('change', () => {
    state.month = sel.value;
    render();
  });

  wireDrill($('#month-report'));
}

function moverRow(m, all) {
  const up = m.delta > 0;
  const driver = up && !m.isGone ? biggestDriver(all, state.month, m.category) : null;
  const why = m.isNew
    ? '<span class="dim">new this month</span>'
    : m.isGone
      ? '<span class="dim">nothing this month</span>'
      : driver
        ? `<span class="dim">mostly ${escapeHtml(String(driver.txn.counterparty || '').slice(0, 26))} (${viz.fmt(driver.txn.amount)})</span>`
        : `<span class="dim">${m.count} transaction${m.count === 1 ? '' : 's'}</span>`;

  return `<tr class="drill" data-drill-cat="${escapeHtml(m.category)}" tabindex="0">
    <td><strong>${escapeHtml(m.category)}</strong></td>
    <td class="num">${m.now ? viz.fmt(m.now) : '—'}</td>
    <td class="num dim">${m.prev ? viz.fmt(m.prev) : '—'}</td>
    <td class="num ${up ? 'shadow' : 'in'}">${up ? '+' : '−'}${viz.fmt(Math.abs(m.delta))}${
      m.pct !== null ? `<span class="dim small"> ${(Math.abs(m.pct) * 100).toFixed(0)}%</span>` : ''
    }</td>
    <td>${why}</td>
  </tr>`;
}

function debtCard({ p, c }) {
  const pct = Math.round(c.pct * 100);
  const clear = c.owed <= 0.5;
  // The amount owed is the one number that matters, so it gets the size. Everything
  // else is context and recedes.
  return `
    <article class="debt-card${clear ? ' is-clear' : ''}">
      <header>
        <h4>${escapeHtml(p.name)}</h4>
        ${p.kind === 'revolving' ? '<span class="pill pill-revolving" title="You can draw on this again — the balance goes up as well as down">revolving</span>' : ''}
        <button class="link-btn debt-remove" data-rmdebt="${escapeHtml(p.id)}" title="Remove this debt">✕</button>
      </header>

      <div class="debt-amount ${clear ? 'in' : ''}">${clear ? 'Cleared' : viz.fmt(c.owed)}</div>
      <div class="debt-sub">${clear ? escapeHtml(p.note || 'nothing outstanding') : 'still owed'}</div>

      <div class="meter" role="img" aria-label="${pct}% paid">
        <div class="meter-fill" style="width:${Math.max(pct, clear ? 100 : 2)}%;${clear ? 'background:var(--good)' : ''}"></div>
      </div>

      <dl class="debt-facts">
        <div><dt>Paid</dt><dd>${c.paid ? viz.fmt(c.paid) : '—'}</dd></div>
        ${c.drawn > 0.5 ? `<div><dt>Drawn</dt><dd class="shadow">+${viz.fmt(c.drawn)}</dd></div>` : ''}
        <div><dt>${p.due ? 'Due' : 'Source'}</dt><dd>${escapeHtml(p.due ? prettyDue(p.due) : c.trackable ? `${c.matched} txns` : 'by hand')}</dd></div>
      </dl>

      ${
        c.trackable
          ? `<p class="debt-note">Updates itself — matches “${escapeHtml(p.match)}” in new statements.</p>`
          : `<p class="debt-note">Nothing matches this automatically — link a payment or record one.</p>`
      }

      ${
        c.linked.length
          ? `<ul class="linked-list">${c.linked
              .map(
                (t) => `<li>
                  <span class="dim small">${shortDate(t.date)}</span>
                  <span>${viz.fmt(t.amount)}</span>
                  <span class="dim small ellip">${escapeHtml(String(t.counterparty || '').slice(0, 22))}</span>
                  <button class="link-btn" data-unlink="${p.id}|${t.id}" title="Unlink">✕</button>
                </li>`
              )
              .join('')}</ul>`
          : ''
      }

      <footer class="debt-actions">
        <button class="btn-quiet" data-pick="${p.id}">Link a payment</button>
        <button class="btn-quiet" data-pay="${p.id}">Enter amount</button>
        <button class="btn-quiet" data-edit="${p.id}">Edit</button>
      </footer>

      <div class="pick-box" data-pick-box="${p.id}" hidden>
        <input type="search" class="pick-search" data-search="${p.id}" placeholder="Search your transactions…" aria-label="Search transactions to link">
        <div class="pick-list" data-list="${p.id}"></div>
        <button type="button" class="ghost pick-close" data-cancel-pick="${p.id}">Close</button>
      </div>

      <form class="pay-form" data-form="${p.id}" hidden>
        <label class="dim small" for="amt-${p.id}">Amount paid outside these accounts (cheque, cash)</label>
        <div class="pay-row">
          <input id="amt-${p.id}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00">
          <button type="submit" class="primary">Save</button>
          <button type="button" class="ghost" data-cancel="${p.id}">Cancel</button>
        </div>
      </form>

      <form class="pay-form edit-form" data-editform="${p.id}" hidden>
        <label class="dim small" for="ed-name-${p.id}">Name</label>
        <input id="ed-name-${p.id}" type="text" value="${escapeHtml(p.name)}">

        <label class="dim small" for="ed-open-${p.id}">Balance owed</label>
        <input id="ed-open-${p.id}" type="number" inputmode="decimal" step="0.01" min="0" value="${p.opening}">

        <label class="dim small" for="ed-asof-${p.id}">…as of this date</label>
        <input id="ed-asof-${p.id}" type="date" value="${escapeHtml(String(p.asOf || '').slice(0, 10))}">

        <label class="dim small" for="ed-match-${p.id}">Matches this word in statements (blank = track by hand)</label>
        <input id="ed-match-${p.id}" type="text" value="${escapeHtml(p.match || '')}" placeholder="e.g. the lender's name">

        <label class="dim small" for="ed-due-${p.id}">Due (a date, or free text like “Target Feb 2027”)</label>
        <input id="ed-due-${p.id}" type="text" value="${escapeHtml(p.due || '')}" placeholder="e.g. Target Feb 2027">

        <label class="dim small" for="ed-kind-${p.id}">Kind</label>
        <select id="ed-kind-${p.id}">
          <option value="fixed"${p.kind !== 'revolving' ? ' selected' : ''}>Fixed — a set amount you pay down</option>
          <option value="revolving"${p.kind === 'revolving' ? ' selected' : ''}>Revolving — you can draw on it again</option>
        </select>

        <p class="hint">A restated balance replaces what came before it, so payments already recorded against this debt are cleared and only ones after that date count again. The transactions themselves aren't touched.</p>
        <div class="pay-row">
          <button type="submit" class="primary">Save</button>
          <button type="button" class="ghost" data-cancel-edit="${p.id}">Cancel</button>
        </div>
      </form>
    </article>`;
}

// Lenders seen in the statements that have NO debt line — money you received from a
// loan app that isn't in "What I owe", so the total understates what you owe. Each
// gets a one-click add; the new line then tracks itself via its match string.
function untrackedLenders(txns, payables) {
  const isOverdraft = (t) =>
    t.type === 'Overdraft Credit' || /^(M-PESA Overdraft|M-PESA Overdraw)/i.test(String(t.counterparty || '').trim());
  const covered = payables.map((p) => (p.match || '').toLowerCase()).filter(Boolean);
  const found = new Map();
  for (const t of txns) {
    // Disbursement legs only. Fuliza has its own panel; repayment-only lenders are
    // already going down, and with no draw seen there's no balance to seed.
    if (t.direction !== 'In' || t.category !== 'Loans & Credit' || isOverdraft(t)) continue;
    const name = String(t.counterparty || '').trim();
    if (!name || /^Fuliza/i.test(name)) continue;
    // The category alone is too weak a test to offer someone a DEBT off the back of.
    // It once surfaced "Agent withdrawal" — M-PESA plumbing, not a lender — and one
    // click booked six figures of imagined borrowing. So the name has to actually look
    // like a lender we know, or the row has to be an explicit disbursement.
    const looksLikeLender = LENDER_RE.test(name) || t.type === 'Loan Disbursement';
    const isPlumbing = /^(Withdrawal|Deposit|Charge|Reversal)$/i.test(t.type || '');
    if (!looksLikeLender || isPlumbing) continue;
    if (covered.some((m) => name.toLowerCase().includes(m))) continue;
    const cur = found.get(name) || { name, drawn: 0, count: 0, last: null };
    cur.drawn += t.amount;
    cur.count++;
    if (!cur.last || t.date > cur.last) cur.last = t.date;
    found.set(name, cur);
  }
  return [...found.values()].sort((a, b) => b.drawn - a.drawn);
}

/**
 * Every lender you have moved money with, and which way it went.
 *
 * Grouped by the LENDER's name rather than the counterparty string, because one
 * lender writes itself several ways - "KCB M-PESA", "KCB M-PESA Withdrawal",
 * "KCB MPESA LOAN" - and three rows for one debt is not a tracker, it is a
 * spelling list. Where no known lender word is in the name the counterparty
 * stands as its own group, so nothing is quietly dropped.
 *
 * Fuliza is left out: it has its own panel, it is repaid automatically the
 * instant money lands, and its hundreds of tiny legs would bury everything
 * else here.
 */
function loanActivity(txns, month) {
  const monthOf = monthResolver(txns);
  const out = new Map();

  for (const t of txns) {
    if (t.category !== 'Loans & Credit') continue;
    const name = String(t.counterparty || '').trim();
    if (!name || /fuliza|overdra/i.test(name)) continue;

    const key = (name.match(LENDER_RE) || [name])[0].toUpperCase();
    const row = out.get(key) || { name: key, repaid: 0, drawn: 0, thisCycle: 0, count: 0, last: null };
    if (t.direction === 'Out') {
      row.repaid += t.amount;
      if (month && monthOf(t) === month) row.thisCycle += t.amount;
    } else {
      row.drawn += t.amount;
    }
    row.count++;
    if (!row.last || t.date > row.last) row.last = t.date;
    out.set(key, row);
  }

  return [...out.values()].sort((a, b) => b.repaid - a.repaid);
}

function renderLoanActivity(txns, month) {
  const el = $('#loan-activity');
  if (!el) return;
  const rows = loanActivity(txns, month);
  if (!rows.length) {
    el.innerHTML = '<p class="hint">No loan payments in what the app is reading.</p>';
    return;
  }

  const repaid = rows.reduce((a, r) => a + r.repaid, 0);
  const drawn = rows.reduce((a, r) => a + r.drawn, 0);
  const cycle = rows.reduce((a, r) => a + r.thisCycle, 0);

  el.innerHTML = `
    <div class="recon-head">
      <div class="recon-stat">
        <span class="kpi-label">Repaid this cycle</span>
        <span class="kpi-value">${viz.fmt(cycle)}</span>
        <span class="kpi-note">not counted as spending</span>
      </div>
      <div class="recon-stat">
        <span class="kpi-label">Repaid in all</span>
        <span class="kpi-value">${viz.fmt(repaid)}</span>
        <span class="kpi-note">over what the app is reading</span>
      </div>
      <div class="recon-stat">
        <span class="kpi-label">Borrowed back</span>
        <span class="kpi-value">${viz.fmt(drawn)}</span>
        <span class="kpi-note">${drawn > repaid ? 'more than you repaid' : 'over the same period'}</span>
      </div>
    </div>
    <table class="mini loan-table">
      <thead><tr><th>Lender</th><th class="num">Repaid</th><th class="num">Borrowed</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr class="drill" data-drill-name="${escapeHtml(r.name)}" tabindex="0"
                       title="Show every payment with ${escapeHtml(r.name)}">
            <td>
              <strong>${escapeHtml(r.name)}</strong>
              <div class="dim small">${viz.fmt(r.repaid - r.drawn)} net out ·
                ${r.count} payment${r.count === 1 ? '' : 's'} · last ${shortDate(r.last)}</div>
            </td>
            <td class="num">${viz.fmt(r.repaid)}</td>
            <td class="num ${r.drawn ? 'in' : 'dim'}">${r.drawn ? viz.fmt(r.drawn) : '—'}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table>
    <p class="hint note">Repaying a loan is not spending — you are giving back money you already
      spent once, and counting it again would charge you twice for the same shopping. That is why
      none of this is in the figure on the home screen. It is still money leaving, which is why it
      is here.</p>`;

  wireDrill(el);
}

/** The "track this" buttons, used by both the empty screen and the full one. */
function wireAddLender(el) {
  el.querySelectorAll('button[data-add-lender]').forEach((b) =>
    b.addEventListener('click', () => {
      const name = b.dataset.addLender;
      store.addPayable({
        name,
        group: 'Loans — revolving',
        kind: 'revolving',
        match: name.toLowerCase(),
        opening: 0,
        asOf: '2020-01-01',
        note: 'Added from statement activity',
        due: null,
      });
      render();
      toast(`Tracking ${name} — now put in what you owe and it follows the payments.`);
    })
  );
}

/**
 * What your lenders say - the ledger built from their own messages.
 *
 * Shown above the balances you typed in, because it is the figure the lender
 * will hold you to: what it wants back, by when, and what it charged. The
 * price is worked out from the latest draw and written two ways, as the fee
 * on what was borrowed and as what that comes to per month, which is the only
 * number that lets a 25-day loan be compared with a 60-day one.
 */
function renderLoanLedger(txns) {
  const box = $('#loan-ledger');
  if (!box) return;
  const rows = loanLedger(store.loanNotices(), txns, isoDay(new Date()));
  if (!rows.length) {
    // Nothing kept yet. On the phone that usually means the lenders' messages
    // were read before the app knew to keep them: the reader only fetches
    // what is newer than its last look, so they have to be read once more.
    const phone = Boolean(window.Android && window.Android.readSms);
    box.hidden = !phone;
    box.innerHTML = phone
      ? `<h2>What your lenders say</h2>
         <p class="hint">The app now keeps what KCB, KCB M-PESA and M-Shwari say about your loans -
           what each wants back, by when, and the fee. Messages read before this version were not
           kept, so read the inbox once more to pick them up. Nothing is counted twice.</p>
         <button class="ghost" type="button" id="btn-loan-reread">Read my messages again</button>`
      : '';
    const again = $('#btn-loan-reread');
    if (again) again.addEventListener('click', () => {
      showView('intake');
      $('#btn-sms-all').click();
    });
    return;
  }
  box.hidden = false;
  const pct = (x) => `${(x * 100).toFixed(x * 100 >= 10 ? 0 : 1)}%`;
  const open = rows.filter((r) => !r.cleared);
  const owed = open.reduce((s, r) => s + r.owed, 0);
  box.innerHTML = `
    <h2>What your lenders say</h2>
    <p class="hint">Read from the lenders' own messages: the figure each one wants back, by when,
      and what it charged. ${open.length ? `<strong>${viz.fmt(owed)}</strong> owed across ${open.length} loan${open.length === 1 ? '' : 's'}.` : 'Nothing open.'}</p>
    ${rows
      .map((r) => {
        const p = r.price;
        const dear = p && p.monthly != null && p.monthly >= 0.1;
        const when = r.dueDate
          ? r.daysLeft == null ? shortDate(r.dueDate)
            : r.daysLeft < 0 ? `was due ${shortDate(r.dueDate)}`
              : r.daysLeft === 0 ? 'due today'
                : `due ${shortDate(r.dueDate)} \u00b7 ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`
          : '';
        return `<div class="loan-row${r.cleared ? ' cleared' : ''}${dear ? ' dear' : ''}">
          <div class="loan-head">
            <b>${escapeHtml(r.lender)}</b>
            <span class="loan-owed">${r.cleared ? 'cleared' : viz.fmt(r.owed)}</span>
          </div>
          <div class="loan-sub">${
            r.cleared
              ? `Said fully paid${r.clearedAt ? ` on ${shortDate(r.clearedAt)}` : ''}.`
              : [
                  r.stated != null ? `Wanted ${viz.fmt(r.stated)} as of ${shortDate(r.statedAt)}` : '',
                  r.repaidSince > 0 ? `${viz.fmt(r.repaidSince)} repaid since` : '',
                  when,
                ].filter(Boolean).join(' \u00b7 ')
          }</div>
          ${p
            ? `<div class="loan-price">Fee ${viz.fmt(p.fee)} on ${viz.fmt(p.on)} = <b>${pct(p.rate)}</b>${
                p.termDays ? ` for ${p.termDays} days` : ''
              }${p.monthly != null ? ` \u2248 <b>${pct(p.monthly)} a month</b>` : ''}${
                dear ? ' \u2014 expensive' : ''
              }</div>`
            : ''}
        </div>`;
      })
      .join('')}`;
}

function renderDebts(txns) {
  renderLoanLedger(txns);
  const list = store.payables();
  const el = $('#debts');
  if (!list.length) {
    // An empty list is not an empty screen: the lenders are in the data even
    // when no balance has been entered, so offer them rather than telling
    // somebody to go and find a backup.
    const missing = untrackedLenders(txns, list);
    el.innerHTML =
      '<p class="hint">No balances entered. A balance is the one thing the statements cannot tell you — ' +
      'what you still owe is between you and the lender — so it has to be typed in once, after which ' +
      'payments track themselves.</p>' +
      (missing.length
        ? `<h3 class="debt-group">Lenders in your statements</h3>
           <table class="mini"><tbody>${missing
             .map(
               (m) => `<tr>
                 <td><strong>${escapeHtml(m.name)}</strong><div class="dim small">last ${shortDate(m.last)}</div></td>
                 <td class="num">${viz.fmt(m.drawn)}<div class="dim small">${m.count} draw${m.count === 1 ? '' : 's'}</div></td>
                 <td class="num"><button class="btn-quiet" data-add-lender="${escapeHtml(m.name)}" data-drawn="${m.drawn}">Track this debt</button></td>
               </tr>`
             )
             .join('')}</tbody></table>`
        : '');
    wireAddLender(el);
    setBadge('#debts-badge', '');
    return;
  }

  const rows = list.map((p) => ({ p, c: computePayable(p, txns) }));
  const owed = rows.reduce((a, r) => a + r.c.owed, 0);
  const drawnSince = rows.reduce((a, r) => a + r.c.drawn, 0);
  setBadge('#debts-badge', `${viz.fmt(owed)} owed`, owed > 0);

  // Settled items stay in the data — a cleared revolving line can be drawn on again,
  // and its history is how you'd notice — but they don't belong in a list of what you
  // owe. Hidden by default, one click away.
  const settled = rows.filter((r) => r.c.owed <= 0.5);
  const open = rows.filter((r) => r.c.owed > 0.5);
  const shown = state.showSettled ? rows : open;

  const groups = new Map();
  for (const r of shown) {
    if (!groups.has(r.p.group)) groups.set(r.p.group, []);
    groups.get(r.p.group).push(r);
  }

  el.innerHTML = `
    <div class="recon-head">
      <div class="recon-stat">
        <span class="kpi-label">Total owed</span>
        <span class="kpi-value">${viz.fmt(owed)}</span>
        <span class="kpi-note">across ${list.length} items</span>
      </div>
      ${
        drawnSince > 0.5
          ? `<div class="recon-stat">
               <span class="kpi-label">Borrowed since</span>
               <span class="kpi-value" style="color:var(--critical)">${viz.fmt(drawnSince)}</span>
               <span class="kpi-note">new draws on revolving lines</span>
             </div>`
          : ''
      }
      ${
        settled.length
          ? `<div class="recon-stat">
               <span class="kpi-label">Settled</span>
               <span class="kpi-value in">${settled.length}</span>
               <span class="kpi-note"><label class="settled-toggle"><input type="checkbox" id="show-settled"${
                 state.showSettled ? ' checked' : ''
               }> show them</label></span>
             </div>`
          : ''
      }
    </div>
    ${(() => {
      const missing = untrackedLenders(txns, list);
      return missing.length
        ? `<h3 class="debt-group">Lenders not tracked yet</h3>
           <p class="hint">Money arrived from these loan apps but they have no line above — so what you owe them isn't in the total. Add one and it tracks itself from here on.</p>
           <table class="mini">
             <tbody>${missing
               .map(
                 (m) => `<tr>
                   <td><strong>${escapeHtml(m.name)}</strong><div class="dim small">last ${shortDate(m.last)}</div></td>
                   <td class="num">${viz.fmt(m.drawn)}<div class="dim small">${m.count} draw${m.count === 1 ? '' : 's'}</div></td>
                   <td class="num"><button class="btn-quiet" data-add-lender="${escapeHtml(m.name)}" data-drawn="${m.drawn}">Track this debt</button></td>
                 </tr>`
               )
               .join('')}</tbody>
           </table>`
        : '';
    })()}
    ${[...groups.entries()]
      .map(
        ([group, items]) => `
      <h3 class="debt-group">${escapeHtml(group)}</h3>
      <div class="debt-grid">${items.map(debtCard).join('')}</div>`
      )
      .join('')}
    <p class="hint note">“Drawn” is new borrowing since the balance was last confirmed — on a revolving line that pushes the balance <em>up</em>, which is why repayments alone never tell you where you stand.</p>`;

  // One-click add for a lender seen in the statements. opening 0 + asOf far in the
  // past: every draw and repayment in the data replays, so the balance is computed
  // rather than guessed. Match on the lender's name so future statements keep it
  // current.
  wireAddLender(el);

  const st = $('#show-settled');
  if (st)
    st.addEventListener('change', (e) => {
      state.showSettled = e.target.checked;
      render();
    });

  // Remove a debt. There was no way to undo adding one, so a line added by mistake
  // (or a suggestion that turned out not to be a lender at all) sat in the total
  // forever. Confirmed, because manual payments recorded against it go with it.
  // Edit a debt. A lender restates the balance (interest, fees, an early-settlement
  // quote) and the figure here has to be able to follow — without a way to change it,
  // a debt was frozen at whatever it was first entered as.
  el.querySelectorAll('button[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const form = el.querySelector(`form[data-editform="${CSS.escape(b.dataset.edit)}"]`);
      const opening = form.hidden;
      el.querySelectorAll('form.pay-form').forEach((f) => (f.hidden = true));
      form.hidden = !opening;
      if (opening) form.querySelector('input').focus();
    })
  );

  el.querySelectorAll('button[data-cancel-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelector(`form[data-editform="${CSS.escape(b.dataset.cancelEdit)}"]`).hidden = true;
    })
  );

  el.querySelectorAll('form[data-editform]').forEach((form) =>
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = form.dataset.editform;
      const q = (sel) => form.querySelector(sel);
      const name = q(`#ed-name-${CSS.escape(id)}`).value.trim();
      const opening = Number(q(`#ed-open-${CSS.escape(id)}`).value);
      const asOf = q(`#ed-asof-${CSS.escape(id)}`).value;
      const match = q(`#ed-match-${CSS.escape(id)}`).value.trim();
      const kind = q(`#ed-kind-${CSS.escape(id)}`).value;
      const due = q(`#ed-due-${CSS.escape(id)}`).value.trim();
      if (!name) return toast('Give it a name.');
      if (!Number.isFinite(opening) || opening < 0) return toast('Enter the balance owed.');
      // The restated balance already accounts for everything paid up to its date, so
      // the old payment records must go or they'd be subtracted a second time.
      store.updatePayable(id, { name, opening, asOf: asOf || null, match, kind, due, manualPaid: 0, linkedIds: [] });
      render();
      toast(`${name} updated — ${viz.fmt(opening)} owed.`);
    })
  );

  el.querySelectorAll('button[data-rmdebt]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = list.find((x) => x.id === b.dataset.rmdebt);
      if (!p) return;
      const c = computePayable(p, txns);
      const extra = p.manualPaid > 0 ? `\n\n${viz.fmt(p.manualPaid)} you recorded by hand will be lost.` : '';
      if (!confirm(`Remove “${p.name}”? It's showing ${viz.fmt(c.owed)} owed.${extra}`)) return;
      store.removePayable(p.id);
      render();
      toast(`Removed “${p.name}”.`);
    })
  );

  // Inline form rather than prompt(): a browser dialog can't be styled, blocks the
  // page, and gives no room to say what the field is for.
  el.querySelectorAll('button[data-pay]').forEach((b) =>
    b.addEventListener('click', () => {
      const form = el.querySelector(`form[data-form="${b.dataset.pay}"]`);
      const opening = form.hidden;
      el.querySelectorAll('form.pay-form').forEach((f) => (f.hidden = true));
      el.querySelectorAll('button[data-pay]').forEach((o) => o.classList.remove('is-open'));
      form.hidden = !opening;
      b.classList.toggle('is-open', opening);
      if (opening) form.querySelector('input').focus();
    })
  );

  el.querySelectorAll('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelector(`form[data-form="${b.dataset.cancel}"]`).hidden = true;
      el.querySelector(`button[data-pay="${b.dataset.cancel}"]`).classList.remove('is-open');
    })
  );

  // --- link an existing transaction to a debt
  const drawList = (id) => {
    const p = list.find((x) => x.id === id);
    const c = computePayable(p, txns);
    const q = el.querySelector(`input[data-search="${id}"]`).value;
    const hits = store.paymentCandidates(id, { query: q, owed: c.owed });
    const linked = new Set(p.linkedIds || []);
    const box = el.querySelector(`div[data-list="${id}"]`);
    box.innerHTML = hits.length
      ? hits
          .map(
            (t) => `<button type="button" class="pick-row${linked.has(t.id) ? ' is-linked' : ''}" data-link="${id}|${t.id}"${
              linked.has(t.id) ? ' disabled' : ''
            }>
          <span class="dim small">${shortDate(t.date)}</span>
          <strong>${viz.fmt(t.amount)}</strong>
          <span class="ellip">${escapeHtml(String(t.counterparty || '—').slice(0, 30))}</span>
          <span class="dim small">${linked.has(t.id) ? 'linked' : t.receipt || ''}</span>
        </button>`
          )
          .join('')
      : '<p class="hint">Nothing matches that search.</p>';

    box.querySelectorAll('button[data-link]').forEach((b) =>
      b.addEventListener('click', () => {
        const [pid, tid] = b.dataset.link.split('|');
        const res = store.linkPayment(pid, tid);
        if (!res.ok) {
          toast(res.error, 'warn');
          return;
        }
        render();
        toast(`Linked ${viz.fmt(res.txn.amount)} to ${list.find((x) => x.id === pid).name}.`);
      })
    );
  };

  el.querySelectorAll('button[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.pick;
      const box = el.querySelector(`div[data-pick-box="${id}"]`);
      const opening = box.hidden;
      el.querySelectorAll('.pick-box').forEach((x) => (x.hidden = true));
      el.querySelectorAll('button[data-pick]').forEach((o) => o.classList.remove('is-open'));
      box.hidden = !opening;
      b.classList.toggle('is-open', opening);
      if (opening) {
        drawList(id);
        box.querySelector('input').focus();
      }
    })
  );

  el.querySelectorAll('input[data-search]').forEach((inp) => {
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => drawList(inp.dataset.search), 140);
    });
  });

  el.querySelectorAll('button[data-cancel-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelector(`div[data-pick-box="${b.dataset.cancelPick}"]`).hidden = true;
      el.querySelector(`button[data-pick="${b.dataset.cancelPick}"]`).classList.remove('is-open');
    })
  );

  el.querySelectorAll('button[data-unlink]').forEach((b) =>
    b.addEventListener('click', () => {
      const [pid, tid] = b.dataset.unlink.split('|');
      store.unlinkPayment(pid, tid);
      render();
      toast('Unlinked.');
    })
  );

  el.querySelectorAll('form.pay-form').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = f.dataset.form;
      const p = list.find((x) => x.id === id);
      const res = store.recordManualPayment(id, parseFloat(f.querySelector('input').value));
      if (!res.ok) {
        toast(res.error, 'warn');
        return;
      }
      render();
      toast(`Recorded against ${p.name}. ${viz.fmt(res.manualPaid)} paid by hand in total.`);
    })
  );
}

function prettyDue(due) {
  if (!due) return '';
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return due; // free text like "Target Jan 2027"
  const overdue = d.getTime() < Date.now();
  return (overdue ? '⚠ ' : '') + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

function renderSettings() {
  const s = store.settings();
  const win = $('#set-window');
  if (win) {
    win.value = s.windowFrom ? `from:${s.windowFrom}` : String(s.windowMonths ?? 0);
    const n = (v) => v.toLocaleString('en-GB');
    const on = store.allTransactions().length;
    const read = visible().length;
    $('#window-note').textContent =
      on === read
        ? `Reading all ${n(on)} transaction${on === 1 ? '' : 's'} on file.`
        : `Reading ${n(read)} of ${n(on)} on file. The other ${n(on - read)} are kept, just not loaded.`;

    // The census. When a screen is unexpectedly empty the first question is
    // always "what dates are actually on file?", and nothing could answer it.
    const dated = store.allTransactions().map((t) => t.date).filter(Boolean).sort();
    const undated = store.undatedTransactions().length;
    const day = (iso) =>
      new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    $('#date-census').textContent = dated.length
      ? `On file: ${day(dated[0])} to ${day(dated.at(-1))}.${undated ? ` ${n(undated)} carry no date.` : ''}`
      : undated
        ? `${n(undated)} transactions on file, and not one carries a date.`
        : '';
    $('#undated-row').hidden = !undated;
    const drop = $('#btn-drop-undated');
    if (drop) drop.textContent = `Remove the ${n(undated)} undated`;
  }
  const lockRow = $('#set-lock-row');
  if (lockRow) {
    const can = Boolean(window.Android && window.Android.canLock && window.Android.canLock());
    lockRow.hidden = !can;
    if (can) $('#set-lock').checked = Boolean(window.Android.isLockEnabled());
  }
  $('#set-name').value = s.name || '';
  $('#set-phones').value = (s.phones || []).join(', ');
  $('#set-accounts').value = (s.accounts || []).join(', ');
  $('#set-limit').value = s.smallSendLimit ?? 200;

  // An unset identity is not a cosmetic gap: internal transfers stop being detected
  // and the same money counts twice. Say so where it can't be missed.
  const ok = isConfigured();
  setBadge('#settings-badge', ok ? `${(s.phones || []).length + (s.accounts || []).length} identifiers` : '⚠ not set up', !ok);
  $('#settings-card').classList.toggle('needs-setup', !ok);

  const cats = Object.keys(CATEGORIES);
  $('#ppl-cat').innerHTML = cats.map((c) => `<option${c === 'Family' ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');

  const people = s.people || [];
  $('#ppl-list').innerHTML = people.length
    ? `<table class="mini"><tbody>${people
        .map(
          (p, i) => `<tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td class="dim">${escapeHtml(p.number)}</td>
        <td class="dim">${escapeHtml(p.category || '')}</td>
        <td class="num"><button class="link-btn" data-rmppl="${i}" title="Remove">✕</button></td>
      </tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="hint">Nobody added yet.</p>';

  $('#ppl-list')
    .querySelectorAll('button[data-rmppl]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const next = [...people];
        next.splice(+b.dataset.rmppl, 1);
        store.saveSettings({ people: next });
        render();
        renderSettings();
      })
    );
}

function wireSettings() {
  const save = () => {
    const split = (v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    store.saveSettings({
      name: $('#set-name').value.trim(),
      phones: split($('#set-phones').value),
      accounts: split($('#set-accounts').value),
      smallSendLimit: parseFloat($('#set-limit').value) || 0,
    });
    render();
    renderSettings();
    toast('Settings saved. They stay in this browser.');
  };
  const lockBox = $('#set-lock');
  if (lockBox && !lockBox.dataset.wired) {
    lockBox.dataset.wired = '1';
    lockBox.addEventListener('change', () => {
      if (window.Android && window.Android.setLockEnabled) window.Android.setLockEnabled(lockBox.checked);
      toast(lockBox.checked ? 'The app will ask who you are when it comes back to the front.' : 'Lock off.');
    });
  }
  ['#set-name', '#set-phones', '#set-accounts', '#set-limit'].forEach((sel) =>
    $(sel).addEventListener('change', save)
  );

  $('#ppl-add').addEventListener('click', () => {
    const name = $('#ppl-name').value.trim();
    const number = $('#ppl-num').value.trim();
    if (!name || !number) {
      toast('A name and a number, please.', 'warn');
      return;
    }
    const people = [...(store.settings().people || []), { name, number: normNumber(number), category: $('#ppl-cat').value }];
    store.saveSettings({ people });
    // Their name is also how their transactions get categorised.
    store.addNameRule(name, $('#ppl-cat').value);
    $('#ppl-name').value = '';
    $('#ppl-num').value = '';
    render();
    renderSettings();
    renderNameRules();
    toast(`${name} added — their bank rows will be named too.`);
  });
}

function renderCategories() {
  const custom = store.getState().customCategories;
  const el = $('#cat-list');
  if (!custom.length) {
    el.innerHTML = '<p class="hint">No custom categories yet — the built-in ones are always available.</p>';
    return;
  }
  const HOW = { spending: 'spending', transfer: 'moved, not spent', income: 'money in', fee: 'a fee' };
  el.innerHTML = `<table class="mini"><tbody>${custom
    .map((c) => {
      const u = store.categoryUsage(c.name);
      return `<tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td class="dim">${HOW[c.class] || c.class}</td>
        <td class="num dim">${u.rules ? `${u.rules} rule${u.rules === 1 ? '' : 's'}` : ''}</td>
        <td class="num"><button class="link-btn" data-rmcat="${escapeHtml(c.name)}" title="Remove category">✕</button></td>
      </tr>`;
    })
    .join('')}</tbody></table>`;

  el.querySelectorAll('button[data-rmcat]').forEach((b) =>
    b.addEventListener('click', () => {
      const name = b.dataset.rmcat;
      const u = store.categoryUsage(name);
      const warn = u.rules || u.overrides
        ? `\n\n${u.rules} name rule(s) and ${u.overrides} manual assignment(s) use it. They will be removed and those transactions go back to Uncategorised.`
        : '';
      if (!confirm(`Remove the category “${name}”?${warn}`)) return;
      store.removeCategory(name);
      applyCustomCategories();
      render();
      renderNameRules();
      renderCategories();
      toast(`Removed “${name}”.`);
    })
  );
}

// Push the user's categories into the live registry every time they change, so the
// dropdowns and class lookups stay in step without a reload.
function applyCustomCategories() {
  registerCustomCategories(store.getState().customCategories);
  const sel = $('#nr-cat');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = Object.keys(CATEGORIES)
      .map((c) => `<option${c === cur ? ' selected' : ''}>${escapeHtml(c)}</option>`)
      .join('');
  }
}

const TRIAGE_LIMIT = 25;

// Selection lives outside render(): setting a rule re-renders the whole panel, and
// losing your ticks every time would make bulk work impossible.
const selected = new Set();
let lastTicked = null; // for shift-click ranges

/**
 * Which account(s) a name's transactions came from. Someone can appear in both —
 * paid by M-PESA sometimes, by bank transfer other times — and seeing "Both" is a
 * hint about the relationship (and about which statement to go looking in).
 */
function acctChips({ mpesa, bank }) {
  const chips = [];
  if (mpesa) chips.push(`<span class="acct acct-mpesa">M-PESA${bank ? ` ${mpesa}` : ''}</span>`);
  if (bank) chips.push(`<span class="acct acct-bank">Bank${mpesa ? ` ${bank}` : ''}</span>`);
  return chips.join('');
}

/** "13 Jun" — or "13 Jun 25" once the year stops being obvious. */
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: '2-digit' }),
  });
}

/**
 * How the transactions sit in time — a one-off reads differently from someone you've
 * paid across six months, and that's often what identifies them.
 */
function span(first, last) {
  if (!first || !last) return '';
  if (first.slice(0, 10) === last.slice(0, 10)) return `on ${shortDate(first)}`;
  return `${shortDate(first)} → ${shortDate(last)}`;
}

// Everything the app has no rule for, grouped by the person/merchant name rather
// than the raw counterparty — the same name arrives under several masked numbers,
// and asking you to categorise the same person three times would be absurd.
function renderTriage(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.category !== 'Uncategorised') continue;
    const name = personName(t.counterparty);
    if (!name) continue;
    const g = groups.get(name) || { name, count: 0, variants: new Set() };
    g.count++;
    g.variants.add(t.counterparty);
    groups.set(name, g);
  }

  // Totals come from the FULL ledger for each name, not just its uncategorised rows.
  // Money coming back from someone is typed "Receive Money" and lands in Income, so
  // counting only uncategorised rows would hide every repayment — and "money came
  // back" is exactly the signal that says this is lending rather than spending.
  // What the app can work out for itself, per name. Only two things are strong
  // enough to offer - money that came back, and an answer already given on one
  // of the rows - and both are explained on the row rather than just applied.
  const chosen = store.getState().overrides || {};
  const all = [...groups.values()]
    .map((g) => {
      const l = store.ledgerFor(g.name);
      const rows = store.rowsFor(g.name);
      const tip = suggestFor(rows, (t) => chosen[t.id]);
      return { ...g, tip, out: l.out, in: l.in, total: l.count, first: l.first, last: l.last, mpesa: l.mpesa, bank: l.bank };
    })
    .sort((a, b) => b.out - a.out);
  const card = $('#triage-card');
  card.hidden = all.length === 0;
  if (!all.length) return;

  const shown = all.slice(0, TRIAGE_LIMIT);
  const rest = all.length - shown.length;
  const totalOut = all.reduce((a, g) => a + g.out, 0);
  setBadge('#triage-badge', `${all.length} names · ${viz.fmt(totalOut)} unassigned`, true);
  const shownOut = shown.reduce((a, g) => a + g.out, 0);
  const opts = Object.keys(CATEGORIES).filter((c) => c !== 'Uncategorised');

  // Where the unassigned money actually sits, counted over the uncategorised rows
  // themselves rather than each name's whole ledger.
  let uncatMpesa = 0;
  let uncatBank = 0;
  for (const t of txns) {
    if (t.category !== 'Uncategorised') continue;
    if ((t.accountSource || 'mpesa') === 'bank') uncatBank++;
    else uncatMpesa++;
  }
  const split = uncatBank
    ? ` · <span class="acct acct-mpesa">M-PESA ${uncatMpesa}</span><span class="acct acct-bank">Bank ${uncatBank}</span>`
    : ' · all from M-PESA';

  // Drop ticks for names that are gone (just categorised, or filtered out).
  const present = new Set(shown.map((g) => g.name));
  for (const n of [...selected]) if (!present.has(n)) selected.delete(n);

  const opts2 = opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('');
  const sure = shown.filter((g) => g.tip && g.tip.sure);

  $('#triage').innerHTML = `
    <p class="hint note"><strong>${all.length} name${all.length === 1 ? '' : 's'}</strong> ·
      ${viz.fmt(totalOut)} unassigned${rest > 0 ? ` · showing the top ${shown.length} (${viz.fmt(shownOut)} of it)` : ''}${split}</p>
    ${
      sure.length
        ? `<div class="bulk-bar tipbar">
             <strong>${sure.length} name${sure.length === 1 ? '' : 's'} the app can work out</strong>
             <button id="tip-apply" class="primary">Take them</button>
           </div>`
        : ''
    }
    <div id="bulk-bar" class="bulk-bar" ${selected.size ? '' : 'hidden'}>
      <strong id="bulk-count"></strong>
      <select id="bulk-cat" aria-label="Category for selected names">${opts2}</select>
      <button id="bulk-apply" class="primary">Apply to selected</button>
      <button id="bulk-clear" class="ghost">Clear</button>
    </div>
    <table class="mini triage-table">
      <thead><tr>
        <th class="tick"><input type="checkbox" id="tick-all" aria-label="Select all shown"></th>
        <th>Name</th><th class="num">Sent</th><th class="num">Back</th><th class="num">Last</th><th>Category</th>
      </tr></thead>
      <tbody>${shown
        .map(
          (g) => `<tr${selected.has(g.name) ? ' class="picked"' : ''}>
          <td class="tick"><input type="checkbox" class="tick-row" data-name="${escapeHtml(g.name)}"${
            selected.has(g.name) ? ' checked' : ''
          } aria-label="Select ${escapeHtml(g.name)}"></td>
          <td>
            <strong>${escapeHtml(g.name)}</strong>
            <div class="dim small">
              ${acctChips(g)}${g.total} txn${g.total === 1 ? '' : 's'}${
                span(g.first, g.last) ? ` · ${span(g.first, g.last)}` : ''
              }${g.variants.size > 1 ? ` · ${g.variants.size} number variants` : ''}${
                g.tip ? ` · <span class="tip">${escapeHtml(g.tip.why)}</span>` : ''
              }
            </div>
          </td>
          <td class="num">${g.out ? viz.fmt(g.out) : '—'}</td>
          <td class="num ${g.in > 0.5 ? 'in' : 'dim'}">${g.in ? viz.fmt(g.in) : '—'}</td>
          <td class="num nowrap" title="${g.last ? new Date(g.last).toLocaleString('en-GB') : ''}">${shortDate(g.last)}</td>
          <td>
            <select class="cat triage-cat" data-name="${escapeHtml(g.name)}">
              <option value="">${g.tip ? `${escapeHtml(g.tip.category)} ?` : '— pick —'}</option>
              ${opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}
            </select>
          </td>
        </tr>`
        )
        .join('')}</tbody>
    </table>
    ${rest > 0 ? `<p class="hint">${rest} smaller name${rest === 1 ? '' : 's'} not shown — assign these and they'll move up.</p>` : ''}`;

  $('#triage').querySelectorAll('select.triage-cat').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const name = sel.dataset.name;
      store.addNameRule(name, sel.value);
      const l = store.ledgerFor(name);
      render();
      renderNameRules();
      toast(`“${name}” → ${sel.value}. ${l.count} transaction${l.count === 1 ? '' : 's'} moved.`);
    });
  });

  const take = $('#tip-apply');
  if (take) {
    take.addEventListener('click', () => {
      // Only the ones it is sure about, and each becomes an ordinary name rule
      // you can see and change in People & name rules - nothing is applied that
      // you cannot find afterwards and undo.
      let moved = 0;
      for (const g of sure) {
        store.addNameRule(g.name, g.tip.category);
        moved += store.ledgerFor(g.name).count;
      }
      render();
      renderNameRules();
      toast(`${sure.length} name${sure.length === 1 ? '' : 's'} assigned · ${moved} transactions moved.`);
    });
  }

  wireBulk(shown);
}

function wireBulk(shown) {
  const order = shown.map((g) => g.name);
  const bar = $('#bulk-bar');
  const count = $('#bulk-count');

  const refresh = () => {
    bar.hidden = selected.size === 0;
    const value = [...selected].reduce((a, n) => a + store.ledgerFor(n).out, 0);
    count.textContent = `${selected.size} selected · ${viz.fmt(value)}`;
    $('#triage')
      .querySelectorAll('tr')
      .forEach((tr) => {
        const cb = tr.querySelector('.tick-row');
        if (cb) tr.classList.toggle('picked', selected.has(cb.dataset.name));
      });
    const allOn = order.length > 0 && order.every((n) => selected.has(n));
    const someOn = order.some((n) => selected.has(n));
    const head = $('#tick-all');
    head.checked = allOn;
    head.indeterminate = someOn && !allOn;
  };

  $('#triage')
    .querySelectorAll('.tick-row')
    .forEach((cb) => {
      cb.addEventListener('click', (e) => {
        const name = cb.dataset.name;
        const i = order.indexOf(name);
        // Shift-click fills the range — the point of bulk is not clicking 25 times.
        if (e.shiftKey && lastTicked !== null) {
          const [a, b] = [Math.min(lastTicked, i), Math.max(lastTicked, i)];
          for (let k = a; k <= b; k++) {
            if (cb.checked) selected.add(order[k]);
            else selected.delete(order[k]);
          }
          $('#triage')
            .querySelectorAll('.tick-row')
            .forEach((o) => (o.checked = selected.has(o.dataset.name)));
        } else if (cb.checked) selected.add(name);
        else selected.delete(name);
        lastTicked = i;
        refresh();
      });
    });

  $('#tick-all').addEventListener('change', (e) => {
    if (e.target.checked) order.forEach((n) => selected.add(n));
    else order.forEach((n) => selected.delete(n));
    $('#triage')
      .querySelectorAll('.tick-row')
      .forEach((o) => (o.checked = selected.has(o.dataset.name)));
    lastTicked = null;
    refresh();
  });

  $('#bulk-clear').addEventListener('click', () => {
    selected.clear();
    $('#triage')
      .querySelectorAll('.tick-row')
      .forEach((o) => (o.checked = false));
    refresh();
  });

  $('#bulk-apply').addEventListener('click', () => {
    const cat = $('#bulk-cat').value;
    const names = [...selected];
    if (!names.length) return;
    let moved = 0;
    for (const n of names) {
      store.addNameRule(n, cat);
      moved += store.ledgerFor(n).count;
    }
    selected.clear();
    lastTicked = null;
    render();
    renderNameRules();
    toast(`${names.length} name${names.length === 1 ? '' : 's'} → ${cat}. ${moved} transaction${moved === 1 ? '' : 's'} moved.`);
  });

  refresh();
}

function renderNameRules() {
  const { nameRules } = store.getState();
  const el = $('#nr-list');
  const owed = nameRules
    .filter((r) => r.category === 'Money Lent')
    .reduce((a, r) => a + Math.max(0, store.ledgerFor(r.match).net), 0);
  setBadge(
    '#people-badge',
    nameRules.length ? `${nameRules.length} rule${nameRules.length === 1 ? '' : 's'}${owed > 0.5 ? ` · ${viz.fmt(owed)} owed to you` : ''}` : '',
    owed > 0.5
  );

  if (!nameRules.length) {
    el.innerHTML = '<p class="hint">No name rules yet.</p>';
    return;
  }
  el.innerHTML = `<table class="mini">
      <thead><tr>
        <th>Name</th><th>Category</th>
        <th class="num">Sent</th><th class="num">Back</th><th class="num">Net</th><th class="num">Last</th><th></th>
      </tr></thead>
      <tbody>${nameRules
        .map((r) => {
          const l = store.ledgerFor(r.match);
          // A rule whose name contains another rule's name is narrower, so it wins.
          // The reverse — a broad rule that no longer catches anything because more
          // specific rules cover all of it — is worth saying out loud rather than
          // leaving someone to wonder why their rule "did nothing".
          const covers = nameRules.filter(
            (o) => o !== r && o.match.toLowerCase().includes(r.match.toLowerCase())
          );
          // For a lending relationship the net is the point: positive means still
          // owed to you, negative means they've returned more than you sent.
          const owed = l.net > 0.5;
          const settled = Math.abs(l.net) <= 0.5;
          const netCls = l.net > 0.5 ? 'owed' : l.net < -0.5 ? 'in' : 'dim';
          return `<tr>
          <td>
            <strong>${escapeHtml(r.match)}</strong>
            <div class="dim small">${l.count} txns${
              covers.length
                ? ` · <span class="shadow" title="More specific rules take priority">${covers
                    .map((c) => escapeHtml(c.match))
                    .join(', ')} overrides this</span>`
                : ''
            }</div>
          </td>
          <td class="dim">${escapeHtml(r.category)}</td>
          <td class="num dim">${l.out ? viz.fmt(l.out) : '—'}</td>
          <td class="num dim">${l.in ? viz.fmt(l.in) : '—'}</td>
          <td class="num ${netCls}">${
            settled && l.count ? 'settled' : l.net > 0.5 ? viz.fmt(l.net) : l.net < -0.5 ? '+' + viz.fmt(-l.net) : '—'
          }</td>
          <td class="num nowrap dim" title="${l.last ? new Date(l.last).toLocaleString('en-GB') : ''}">${shortDate(l.last)}</td>
          <td class="num"><button class="link-btn" data-rm="${escapeHtml(r.match)}" title="Remove rule">✕</button></td>
        </tr>`;
        })
        .join('')}</tbody></table>
      <p class="hint">“Net” is what's still out: a figure means they owe you that much, <span class="in">+n</span> means they've sent back more than you sent, “settled” means square. Tag someone <strong>Money Lent</strong> and neither direction counts as spending or income.</p>`;

  el.querySelectorAll('button[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      store.removeNameRule(b.dataset.rm);
      render();
      renderNameRules();
    })
  );
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function applyFilters(txns) {
  const q = state.search.trim().toLowerCase();
  // The SAME rule every report uses to decide which month a transaction belongs to.
  // Filtering by calendar date instead was why clicking a row in the monthly report
  // could return nothing: the report counts by pay cycle, so a 29 July payment sits in
  // August — and a calendar-month filter looked for it in July and found nothing.
  const monthOfTxn = monthResolver(txns);
  return txns.filter((t) => {
    if (state.drillFrom && !(t.date && t.date.slice(0, 10) >= state.drillFrom)) return false;
    if (state.drillTo && !(t.date && t.date.slice(0, 10) <= state.drillTo)) return false;
    if (state.drillClass === 'spending') {
      const k = classOf(t.category);
      if (k !== CLASSES.SPENDING && k !== CLASSES.FEE) return false;
    }
    // Category + month together, so a split payment assigned to another budget month
    // shows up when you drill THAT month. A slice matches if its category fits the
    // filter AND its month is the drilled one — its own if the slice was assigned one,
    // otherwise the transaction's.
    if (state.drillMonth || state.catFilter !== 'all' || state.drillCats) {
      const parts =
        t.splits && t.splits.length ? t.splits : [{ category: t.category, month: null }];
      const monthOf = (p) => p.month || monthOfTxn(t);
      const inSet = (p) => !state.drillCats || state.drillCats.includes(p.category);
      const hit = parts.some(
        (p) =>
          (state.catFilter === 'all' || p.category === state.catFilter) &&
          inSet(p) &&
          (!state.drillMonth || monthOf(p) === state.drillMonth)
      );
      if (!hit) return false;
    }
    if (state.dirFilter !== 'all' && t.direction !== state.dirFilter) return false;
    // Anything without an explicit source predates the bank importer and is M-PESA.
    if (state.acctFilter !== 'all' && (t.accountSource || 'mpesa') !== state.acctFilter) return false;
    if (!q) return true;
    return `${t.counterparty} ${t.receipt} ${t.account || ''} ${t.type} ${t.note || ''}`.toLowerCase().includes(q);
  });
}

// Only offer categories that are actually present, so the filter never lands on
// an empty list.
function refreshCategoryFilter(txns) {
  const sel = $('#cat-filter');
  const present = [...new Set(txns.map((t) => t.category))].sort();
  const cur = state.catFilter;
  sel.innerHTML =
    '<option value="all">All categories</option>' +
    present.map((c) => `<option${c === cur ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  if (cur !== 'all' && !present.includes(cur)) {
    state.catFilter = 'all';
    sel.value = 'all';
  }
}

// Built from what's actually imported — the list of banks isn't fixed, and hard-coding
// it meant a new one arrived invisible.
function refreshAccountFilter(txns) {
  const sel = $('#acct-filter');
  const present = [...new Set(txns.map((t) => t.accountSource || 'mpesa'))].sort();
  const cur = state.acctFilter;
  sel.innerHTML =
    '<option value="all">All accounts</option>' +
    present
      .map((a) => `<option value="${a}"${a === cur ? ' selected' : ''}>${escapeHtml(ACCOUNT_LABELS[a] || a)}</option>`)
      .join('');
  if (cur !== 'all' && !present.includes(cur)) {
    state.acctFilter = 'all';
    sel.value = 'all';
  }
}

/**
 * Make anything carrying data-drill-cat / data-drill-name filter the table to it.
 * A chart that shows one big "Groceries" bar and can't tell you what's inside is a
 * dead end — every number should be a question you can follow.
 */
function wireDrill(root, scopeMonth) {
  root.querySelectorAll('[data-drill-cat], [data-drill-cats], [data-drill-name]').forEach((el) => {
    const go = () => {
      const cat = el.dataset.drillCat;
      const cats = el.dataset.drillCats;
      const name = el.dataset.drillName;
      state.drillCats = null;
      state.drillBudget = null;
      if (cats) {
        // A set of categories: the ring's folded slice, or a budget line, which
        // covers several and so cannot be expressed as one category name.
        state.drillCats = cats.split('|');
        state.drillCatsLabel = el.dataset.drillLabel || '';
        state.drillBudget = el.dataset.drillBudget || null;
        state.catFilter = 'all';
        state.search = '';
      }
      if (cat) {
        state.catFilter = cat;
        state.search = '';
      }
      if (name) {
        state.search = name;
        state.catFilter = 'all';
      }
      // Drilling from the monthly report or the budget means "in that month" —
      // otherwise you'd click June's Groceries and get every month's.
      state.drillMonth =
        scopeMonth !== undefined ? scopeMonth : root.id === 'month-report' ? state.month : null;
      state.dirFilter = 'all';
      render();
      const table = $('#table-txns');
      showView('txns');
      table.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const n = state.drillCats ? state.drillCats.length : 0;
      const what =
        cat || name || state.drillCatsLabel || `${n} smaller categor${n === 1 ? 'y' : 'ies'}`;
      toast(`Showing ${what}${state.drillMonth ? ` in ${monthLabel(state.drillMonth)}` : ''}. Clear the filters to go back.`);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
}

/* The two pages are one app at one origin; these are how they hand figures to
   each other without either having to recompute the other's work. */
const TRACKER_GLANCE = 'mpesa-tracker.glance';
const BASKET_GLANCE = 'basket.glance';
const BASKET_RECEIPTS = 'basket-receipts-v1';
const BASKET_PULLED = 'mpesa-tracker.basket-pulled';

/**
 * Which view is on screen.
 *
 * Nineteen panels used to sit open on one page. They are the same panels; what
 * changed is that you now go INTO one and come back, so the home screen can be a
 * home screen. The hash carries it, which means Android's back button works for
 * free - no history stack of our own to get out of step.
 */
function showView(view, push = true) {
  const target = document.querySelector(`.view[data-view="${view}"]`) ? view : 'home';
  document.querySelectorAll('.view').forEach((v) => {
    v.hidden = v.dataset.view !== target;
  });
  // Cash is computed, not stored, so it has to be worked out on the way in -
  // including when you arrive by the back button or a link rather than a tap.
  if (target === 'cash') renderCash();
  const want = target === 'home' ? ' ' : `#${target}`;
  if (push && location.hash.replace('#', '') !== target && !(target === 'home' && !location.hash)) {
    history.pushState(null, '', want);
  }
  window.scrollTo(0, 0);
}

function wireViewLinks(root) {
  root.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => showView(el.dataset.go));
  });
}

function wireWindow() {
  const drop = $('#btn-drop-undated');
  if (drop) {
    drop.addEventListener('click', () => {
      const count = store.undatedTransactions().length;
      if (!count) return;
      // A parsing accident, but still the user's records, so say what this does.
      const ok = confirm(
        `Remove ${count} transaction${count === 1 ? '' : 's'} that have no date?

` +
          'They cannot be placed in any month, so no total, chart or report can use them. ' +
          'Reading your messages again will bring back any that can be dated.'
      );
      if (!ok) return;
      const gone = store.removeUndated();
      render();
      renderSettings();
      toast(`Removed ${gone} undated transaction${gone === 1 ? '' : 's'}.`);
    });
  }

  const win = $('#set-window');
  if (!win) return;
  win.addEventListener('change', () => {
    const v = win.value;
    if (v.startsWith('from:')) {
      store.saveSettings({ windowFrom: v.slice(5) });
      toast(`Reading from ${shortDate(v.slice(5))} onwards.`);
    } else {
      // A rolling window and a fixed date are alternatives, so choosing one has
      // to clear the other - otherwise the date would silently keep winning.
      store.saveSettings({ windowFrom: null, windowMonths: parseInt(v, 10) });
      toast(v === '0' ? 'Reading everything on file.' : `Reading a rolling ${v} months.`);
    }
    render();
    renderSettings();
  });
}

/**
 * The menu in the corner: the things that are setup rather than money.
 *
 * They were all reachable before, two taps down behind "Everything else" -
 * which is the right place for a report and the wrong one for "add a category".
 */
function wireMenu() {
  const btn = $('#btn-menu');
  const menu = $('#menu');
  const scrim = $('#menu-scrim');
  if (!btn || !menu) return;

  const show = (open) => {
    menu.hidden = !open;
    if (scrim) scrim.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    const ver = $('#menu-version');
    if (open && ver) {
      // window.Android directly: `bridge` is a local inside two other
      // functions, and reaching for it here was a ReferenceError that only
      // showed up as a silently empty line.
      const a = window.Android;
      const v = a && a.appVersion ? a.appVersion() : null;
      ver.textContent = v ? `Version ${v}` : `Pages ${ASSET_BUILD}`;
    }
  };

  btn.addEventListener('click', () => show(menu.hidden));
  // Scrolling the page with a menu open is a menu you have forgotten about,
  // sitting over the thing you are trying to read. The gesture is listened for
  // as well as the scroll it causes: a scroll event is not guaranteed (a list
  // already at its end fires none) and the intent is the same either way.
  const closeOnMove = () => {
    if (!menu.hidden) show(false);
  };
  for (const ev of ['scroll', 'wheel', 'touchmove']) {
    addEventListener(ev, closeOnMove, { passive: true, capture: true });
  }
  if (scrim) scrim.addEventListener('click', () => show(false));
  // Every row closes it: a menu you have to dismiss as well as choose from is
  // one more tap than anyone wants. The update buttons are the exception -
  // closing on the tap that starts the check is how you end up tapping it
  // again, because nothing on screen ever said it had begun.
  menu.querySelectorAll('button').forEach((el) => {
    if (el.closest('#update-box')) return;
    el.addEventListener('click', () => show(false));
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') show(false);
  });
}

function wireViews() {
  wireViewLinks(document);
  document.querySelectorAll('.back').forEach((b) => {
    b.addEventListener('click', () => history.back());
  });
  addEventListener('popstate', () => showView(location.hash.replace('#', '') || 'home', false));
  showView(location.hash.replace('#', '') || 'home', false);
}

// the page springs back to its defaults, which is maddening mid-triage.
/** A summary line for panels that are closed — collapsed shouldn't mean invisible. */
function setBadge(id, text, alert = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('alert', !!alert && !!text);
}

function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  setTimeout(() => (el.className = 'toast'), 4000);
}

/**
 * Shows what could not be read, grouped by wording.
 *
 * It used to print every failed message in full, one after another. With an inbox
 * behind it that is several hundred blocks of monospace on the home page, which
 * tells you nothing you can act on and buries everything below it. The same
 * failures grouped by shape are five or six lines, and the count is the part that
 * matters: it says which wording is worth teaching the parser next.
 */
function showUnparsed(list, ignored = 0) {
  const box = $('#unparsed');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = ignored
      ? `<p class="hint">${ignored} message${ignored === 1 ? ' was a notice' : 's were notices'} &mdash; balance checks and the like, not transactions.</p>`
      : '';
    return;
  }
  const esc = (t) => String(t).replace(/[<>&]/g, '');
  box.innerHTML = `
    <details class="unread">
      <summary><b>${list.length} message${list.length === 1 ? '' : 's'} not recognised</b> &mdash; nothing was dropped silently</summary>
      <p class="hint">Grouped by wording. The counts say which one is worth teaching the app next.</p>
      <ul class="unread-list">
        ${groupUnparsed(list)
          .map((g) => `<li><span class="unread-n">${g.count}&times;</span><pre>${esc(g.sample).slice(0, 220)}</pre></li>`)
          .join('')}
      </ul>
      ${ignored ? `<p class="hint">${ignored} more ${ignored === 1 ? 'was a notice' : 'were notices'} &mdash; balance checks and the like, not transactions.</p>` : ''}
    </details>`;
}

function handlePaste() {
  const raw = $('#sms-input').value;
  if (!raw.trim()) return;

  const { transactions, unparsed, ignored, settled, notices } = parseMessages(raw);
  const noted = store.noteSettlements(settled) + store.addLoanNotices(notices);
  if (!transactions.length) {
    // A message can carry no money and still change the picture - a lender
    // saying a loan is finished removes it from what is expected next.
    if (noted) {
      render();
      toast('Noted: that loan is settled, so it has stopped being expected.');
    } else {
      toast('Could not read any M-PESA messages in that text.', 'warn');
    }
    showUnparsed(unparsed, ignored);
    return;
  }
  const { added, duplicate } = store.addTransactions(transactions);
  $('#sms-input').value = '';
  render();

  let msg = `Added ${added} transaction${added === 1 ? '' : 's'}.`;
  if (duplicate) msg += ` ${duplicate} already on file, skipped.`;
  if (unparsed.length) msg += ` ${unparsed.length} message(s) not recognised.`;
  toast(msg, unparsed.length ? 'warn' : 'ok');

  showUnparsed(unparsed, ignored);
}

async function handlePDF(file) {
  const pw = $('#pdf-password').value;
  if (!pw) {
    toast('Statement PDFs are password-protected — enter yours first.', 'warn');
    return;
  }
  toast('Reading statement…');
  try {
    const { importPDF } = await import('./import.js');
    const buf = await file.arrayBuffer();
    const { transactions, text, pages, kind, label, unresolved, reconciled } = await importPDF(buf, pw);
    let named = 0;

    if (!transactions.length) {
      // Decrypted fine but matched no rows: the layout differs from what's expected.
      // Show what the parser actually saw — a bare "0 rows" is impossible to act on.
      $('#unparsed').innerHTML =
        `<strong>Opened ${pages} page(s) but matched no transaction rows.</strong>
         <p>This is what the parser read — the row format must differ from the expected
         <code>Receipt · Time · Details · Status · Amount · Balance</code>:</p>
         <pre>${text.slice(0, 700).replace(/[<>&]/g, '')}</pre>`;
      toast('No transaction rows found — see the diagnostic panel above.', 'warn');
      return;
    }

    $('#unparsed').innerHTML = '';
    const res = store.addTransactions(transactions);
    const { added, duplicate } = res;
    named = res.named;
    render();

    let msg = `${label} statement imported: ${added} new, ${duplicate} already on file.`;
    if (named) msg += ` Named ${named} row(s) from your M-PESA contacts.`;
    // Most bank layouts carry no +/- sign; direction comes from the running balance.
    // `reconciled === null` means the statement declares nothing to check against
    // (the KCB mini statement) — that's different from failing, and saying "checked"
    // when nothing was checked would be a lie.
    if (reconciled === false) {
      msg += ` ⚠ ${unresolved} row(s) didn't reconcile against the running balance — check their direction.`;
      toast(msg, 'warn');
    } else if (reconciled === true) {
      toast(`${msg} Balance reconciled.`);
    } else {
      toast(`${msg} (This statement prints no totals, so there's nothing to check it against.)`);
    }
  } catch (err) {
    const msg = /password/i.test(err.message) ? 'Wrong statement password.' : `Could not read that PDF: ${err.message}`;
    toast(msg, 'warn');
  } finally {
    $('#pdf-password').value = '';
  }
}

function wire() {
  $('#btn-add').addEventListener('click', handlePaste);
  $('#sms-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePaste();
  });

  $('#pdf-file').addEventListener('change', (e) => {
    if (e.target.files[0]) handlePDF(e.target.files[0]);
    e.target.value = '';
  });

  $('#range').addEventListener('change', (e) => {
    state.range = e.target.value;
    render();
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    // Debounced: re-rendering ~1,100 rows on every keystroke is visibly janky.
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.search = v;
      render();
    }, 120);
  });

  $('#cat-filter').addEventListener('change', (e) => {
    state.catFilter = e.target.value;
    state.drillCats = null; // picking one category replaces a set of them
    render();
  });

  $('#dir-filter').addEventListener('change', (e) => {
    state.dirFilter = e.target.value;
    render();
  });

  $('#acct-filter').addEventListener('change', (e) => {
    state.acctFilter = e.target.value;
    render();
  });

  // A CSV of the selected month: totals, categories, then every transaction. Excel
  // opens it directly, which is where this data came from.
  $('#btn-export-month').addEventListener('click', () => {
    const all = decorate(visible());
    const m = state.month;
    const { now } = compareMonths(all, m);
    // Same month rule as the header totals above (pay cycle, not calendar) — otherwise
    // the file's own summary says 135 transactions and then lists 60 of them.
    const monthOf = monthResolver(all);
    const rows = all.filter((t) => t.date && monthOf(t) === m).sort((a, b) => (a.date < b.date ? -1 : 1));
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csv = [
      [q(`M-PESA Tracker — ${monthLabel(m)}`)],
      [],
      [q('Spent'), now.spent.toFixed(2)],
      [q('Received'), now.income.toFixed(2)],
      [q('Net'), now.net.toFixed(2)],
      [q('Fees'), now.fees.toFixed(2)],
      [q('Moved / repaid'), now.transfers.toFixed(2)],
      [],
      [q('Category'), q('Total'), q('Transactions')],
      ...now.categories.map((c) => [q(c.category), c.total.toFixed(2), c.count]),
      [],
      [q('Date'), q('Account'), q('Direction'), q('Amount'), q('Category'), q('Counterparty'), q('Type'), q('Receipt'), q('Balance')],
      ...rows.map((t) => [
        q(t.date ? new Date(t.date).toLocaleString('en-GB') : ''),
        q(t.accountSource || 'mpesa'),
        q(t.direction),
        t.amount.toFixed(2),
        q(t.category),
        q(t.counterparty),
        q(t.type),
        q(t.receipt || ''),
        t.balance != null ? t.balance.toFixed(2) : '',
      ]),
    ]
      .map((r) => r.join(','))
      .join('\n');

    // BOM so Excel reads UTF-8 and doesn't mangle the names.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mpesa-${m}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${monthLabel(m)} — ${rows.length} transactions.`);
  });

  $('#btn-print').addEventListener('click', () => {
    // Every view at once: a printed report that stops at whichever one you
    // happened to be looking at would be worse than no report.
    document.body.classList.add('printing');
    setTimeout(() => {
      window.print();
      document.body.classList.remove('printing');
    }, 60);
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mpesa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // On the phone the app looks after its own backups - see backupNow. These
  // two only show where there is a bridge to write through.
  const nowBtn = $('#btn-backup-now');
  const restoreBtn = $('#btn-restore-file');
  const note = $('#backup-note');
  if (window.Android && window.Android.saveBackup) {
    nowBtn.hidden = false;
    restoreBtn.hidden = false;
    note.hidden = false;
    const last = localStorage.getItem(BACKUP_LAST_KEY);
    note.textContent = last
      ? `The app writes a backup to Download/BudgetTracker every day it is opened (keeps the last ten). Last one: ${last}.`
      : 'The app writes a backup to Download/BudgetTracker every day it is opened, and keeps the last ten.';
    nowBtn.addEventListener('click', () => {
      const where = backupNow(true);
      toast(where.startsWith('ok:') ? `Saved to ${where.slice(3)}` : `Backup failed: ${where.slice(4)}`);
      if (where.startsWith('ok:')) note.textContent = `Backed up just now to ${where.slice(3)}.`;
    });
    restoreBtn.addEventListener('click', () => window.Android.restoreBackup());
  }

  // Sharing a file beats downloading one on a phone: a download lands in a folder you
  // then have to find and move. The share sheet puts it straight into WhatsApp, Drive
  // or email, which is how it reaches the laptop.
  const shareBtn = $('#btn-share');
  const backupFile = () =>
    new File([store.exportJSON()], `mpesa-backup-${new Date().toISOString().slice(0, 10)}.json`, {
      type: 'application/json',
    });
  if (navigator.canShare && navigator.canShare({ files: [backupFile()] })) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [backupFile()], title: 'M-PESA Tracker backup' });
      } catch (err) {
        // AbortError just means they closed the sheet — not worth a message.
        if (err.name !== 'AbortError') toast(`Couldn't share: ${err.message}`, 'warn');
      }
    });
  }

  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = store.importJSON(await f.text());
      store.applySettings();
      applyCustomCategories();
      render();
      renderNameRules();
      renderCategories();
      renderSettings();

      // Say what actually happened. "Backup restored" hides whether it brought in
      // anything at all — and merging is exactly when you want to know.
      const bits = [];
      if (r.added) bits.push(`${r.added} new transaction${r.added === 1 ? '' : 's'}`);
      if (r.duplicate) bits.push(`${r.duplicate} already here`);
      if (r.nameRules) bits.push(`${r.nameRules} name rule${r.nameRules === 1 ? '' : 's'}`);
      if (r.categories) bits.push(`${r.categories} categor${r.categories === 1 ? 'y' : 'ies'}`);
      if (r.payables) bits.push('debts merged');
      if (r.settingsMerged) bits.push('settings merged');
      toast(bits.length ? `Merged: ${bits.join(', ')}.` : 'Nothing new in that file — everything was already here.');
    } catch (err) {
      toast(err.message, 'warn');
    }
    e.target.value = '';
  });

  // Categories
  const addCat = () => {
    const name = $('#cat-name').value.trim();
    const res = store.addCategory(name, $('#cat-class').value);
    if (!res.ok) {
      toast(res.error, 'warn');
      return;
    }
    $('#cat-name').value = '';
    applyCustomCategories();
    render();
    renderCategories();
    toast(`Added “${res.name}” — it's in every dropdown now.`);
  };
  $('#cat-add').addEventListener('click', addCat);
  $('#cat-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCat();
  });

  // Name rules
  $('#nr-cat').innerHTML = Object.keys(CATEGORIES)
    .map((c) => `<option${c === 'Family' ? ' selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');

  const preview = () => {
    const v = $('#nr-name').value.trim();
    const el = $('#nr-preview');
    if (!v) {
      el.textContent = '';
      return;
    }
    // Show the reach before committing — a fragment like "an" would silently swallow
    // half the ledger, and the count makes that obvious rather than surprising.
    const l = store.ledgerFor(v);
    if (!l.count) {
      el.textContent = `“${v}” matches nothing yet — the rule will still apply to future transactions.`;
      return;
    }
    // Surface the two-way picture up front: if money has come back, this is probably
    // a lending relationship rather than plain spending.
    const back = l.in > 0.5 ? ` — you sent ${viz.fmt(l.out)}, ${viz.fmt(l.in)} came back` : '';
    el.textContent = `“${v}” matches ${l.count} transaction${l.count === 1 ? '' : 's'}${back}.`;
  };
  $('#nr-name').addEventListener('input', preview);

  const addRule = () => {
    const name = $('#nr-name').value.trim();
    const cat = $('#nr-cat').value;
    const res = store.addNameRule(name, cat);
    if (!res.ok) {
      toast(res.error, 'warn');
      return;
    }
    const n = store.countMatching(name);
    $('#nr-name').value = '';
    $('#nr-preview').textContent = '';
    render();
    renderNameRules();
    toast(`“${name}” → ${cat}. ${n} transaction${n === 1 ? '' : 's'} recategorised.`);
  };
  $('#nr-add').addEventListener('click', addRule);
  $('#nr-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRule();
  });

  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    render(); // charts pick colors per-mode, so they must be redrawn
  });

  // The look changes what the hero card DRAWS, not only its colours, so this
  // one has to re-render too.
  const lookBtn = $('#btn-look');
  if (lookBtn) {
    lookBtn.addEventListener('click', () => {
      applyLook(lookNow() === 'minted' ? 'default' : 'minted');
      render();
    });
  }

  $('#btn-reset').addEventListener('click', () => {
    if (confirm('Delete all transactions and rules from this browser? Export a backup first if you want to keep them.')) {
      store.reset();
      location.reload();
    }
  });
}

/**
 * An SMS shared into the app from the phone's share sheet arrives as ./?text=…
 *
 * A browser can't read your inbox — no web API exists for it — so this is as close
 * as it gets: the message arrives by your choosing rather than being harvested.
 */
function handleShared() {
  const p = new URLSearchParams(location.search);
  const shared = [p.get('text'), p.get('title'), p.get('url')].filter(Boolean).join('\n');
  if (!shared.trim()) return;

  // Strip it from the address bar so a reload doesn't add the same thing twice.
  // (Dedupe would catch it anyway, but the toast lying "added 1" would not.)
  history.replaceState(null, '', location.pathname);

  const { transactions, unparsed, notices } = parseMessages(shared);
  store.addLoanNotices(notices);
  if (!transactions.length) {
    $('#sms-input').value = shared;
    showView('intake');
    toast("Shared, but I couldn't read an M-PESA message in it. It's in the box above.", 'warn');
    return;
  }
  const { added, duplicate } = store.addTransactions(transactions);
  render();
  toast(
    added
      ? `Added ${added} transaction${added === 1 ? '' : 's'} from the shared message.${
          unparsed.length ? ` ${unparsed.length} bit(s) not recognised.` : ''
        }`
      : `Already had that one — nothing double-counted.`
  );
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // In the Android app every asset is already local, so a worker would only be
  // a second cache standing between an update and the page.
  if (window.Android) return;
  // Needs a secure context: https, or localhost. Over a plain LAN IP the browser
  // refuses, which is also why the app can't be installed that way.
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err.message));
}

async function init() {
  startTheme();
  startLook();

  store.load();
  // Identity must reach config before anything parses or categorises — isSelf() and
  // the small-send limit are consulted during the very first render.
  store.applySettings();
  // Catch data imported before this existed, and any pairing a later import enabled.
  store.resolveIdentities();
  // Custom categories must land in the registry before the first render, or the
  // dropdowns build without them and a stored rule would point at a missing option.
  registerCustomCategories(store.getState().customCategories);
  // No seed data. It used to ship the 89 rows from the original xlsx, but those are
  // a strict subset of the real statement — and its charge ids used a different
  // suffix scheme, so one row survived dedupe as a phantom. Statements are the
  // source of truth; the app starts empty and you import.
  wireViews();
  wireMenu();
  wireWindow();
  wire();
  wireSettings();
  wireSms();
  wireCash();
  wireCategoryPicker();
  wireBackOverlays();
  wireUpdates();
  // Basket's receipts live at this same origin now, so they are simply read.
  pullBasketReceipts();
  render();
  renderNameRules();
  renderCategories();
  renderSettings();
  wireBasket();
  renderBasket();

  handleShared();
  registerSW();

  // First run: the identity panel is the one thing that must be filled in, so open it.
  if (!isConfigured()) showView('settings');
  // Nothing on file yet: the home screen would be four zeros and a list.
  else if (!store.allTransactions().length && !location.hash) showView('intake');
}


/* ---- The home screen ----------------------------------------------------- */
/*
 * One card, answering the only question that matters on opening the app: how
 * much of this month's money is left. Every figure is budgetReport's, the same
 * one the Budget panel uses - a home screen that disagreed with the panel
 * below it would be worse than no home screen.
 */

/* Pay lands on the 28th, so a month runs from the 28th to the 27th. salary.js
 * works the real boundary out from the statements; this is the fallback for a
 * device with no pay on file yet, and it matches how Basket counts. */
const PAY_DAY = CYCLE_DAY;

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function shiftDay(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthOn(iso, step) {
  const [y, m] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1 + step, 1, 12));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${iso.slice(8)}`;
}

/** The cycle today sits in, by the 28th rule. */
function cycleFromDay(todayIso) {
  const start = todayIso.slice(0, 8) + String(PAY_DAY).padStart(2, '0');
  return +todayIso.slice(8) < PAY_DAY ? monthOn(start, -1) : start;
}

/**
 * The days a budget month covers: payday to the day before the next payday.
 * Shown because a figure for "this month" you can't see the edges of is one
 * you can't check.
 */
function cycleBounds(all, cycleStart, todayIso) {
  // One month long, always. It used to end wherever the NEXT detected pay run
  // happened to land, so a month with no recognised payday after it ran on and
  // on, and the dates on the card stopped matching the month named beside them.
  const from = (cycleStart || cycleFromDay(todayIso)).slice(0, 10);
  return { from, to: shiftDay(monthOn(from, 1), -1) };
}


/**
 * Open the transaction list showing exactly what a figure counted.
 *
 * Biggest first, because the question behind "how did I spend that much" is
 * almost always answered by the top two or three rows.
 */
function openBehind({ month = null, from = null, to = null, dir = 'all', search = '', spending = false, label }) {
  state.drillMonth = month;
  state.drillFrom = from;
  state.drillTo = to;
  state.drillClass = spending ? 'spending' : null;
  state.drillCats = null;
  state.drillBudget = null;
  state.dirFilter = dir;
  state.search = search;
  state.catFilter = 'all';
  state.acctFilter = 'all';
  state.txnLimit = 150;
  state.sort = { key: 'amount', dir: 'desc' };
  const box = $('#search');
  if (box) box.value = search;
  render();
  showView('txns');
  toast(`${label} \u2014 biggest first. Clear the filters to go back.`);
}

/** Makes a card open the figure it is showing. */
function wireBehind(el, get) {
  if (!el) return;
  el.classList.add('openable');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  const go = (e) => {
    // An Upcoming card has its own link inside it; let that win.
    if (e.target.closest('[data-go]') && e.target.closest('[data-go]') !== el) return;
    // Anything inside that opens something MORE specific wins. The ring's
    // slices sit inside the gauge card: without this a tap on Groceries set
    // its category and the card's own handler then replaced it with the whole
    // cycle, so every colour opened the same list and the ring looked dead.
    const drill =
      e.target.closest && e.target.closest('[data-drill-cat], [data-drill-cats], [data-drill-name]');
    if (drill && drill !== el) return;
    // The chips sit INSIDE the gauge card, and both are openable - without
    // this a tap on RECEIVED ran its own handler and then the card's, and the
    // filters ended up a mixture of the two: "spending only / in only", which
    // can never match anything.
    e.stopPropagation();
    openBehind(get());
  };
  el.addEventListener('click', go);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go(e);
    }
  });
}

/**
 * What is in each account, from the last message that said so.
 *
 * Read from EVERY transaction on file rather than the window, because a
 * balance is the latest one that exists - narrowing the window should change
 * what you are looking at, never what you have.
 */
/** Movement the phone has been asked not to make. */
const stillPlease = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Count a figure up to itself.
 *
 * Only worth doing where the number is the point of the screen, and only
 * once: a total that re-counts every time anything on the page changes is a
 * fidget, not an entrance. The easing is fast at first and long at the end,
 * so the last few hundred land slowly enough to read.
 */
function countUp(el, to, ms = 1100) {
  if (!el) return;
  if (stillPlease() || !to) {
    el.textContent = viz.fmt(to);
    return;
  }
  const started = performance.now();
  let frames = 0;
  const step = (now) => {
    frames += 1;
    const t = Math.min(1, (now - started) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = viz.fmt(Math.round(to * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // A view that is not painting yet never calls back - and a total frozen at
  // zero is a far worse bug than one that simply did not move.
  setTimeout(() => { if (!frames) el.textContent = viz.fmt(to); }, 300);
}

/** A category that names nothing: money filed here is money not yet understood. */
const VAGUE = /^(other services|other|others|miscellaneous|misc|general|sundry)$/i;

/**
 * What this month needs from you before its figures mean much.
 *
 * The app knows exactly how many rows nobody has sorted and how much of the
 * month sits under a name that names nothing, and until now it said neither:
 * a ring is only as good as the sorting behind it, and an "Other Services"
 * slice at 18% is a fifth of the money the ring cannot explain. Each line
 * opens the rows it is about, in this cycle, so the fix is one tap away.
 */
function renderAttention(cycle, month) {
  const box = $('#home-attend');
  if (!box) return;
  const out = cycle.filter((t) => t.direction === 'Out');
  const lines = [];

  const loose = out.filter((t) => t.category === 'Uncategorised');
  if (loose.length) {
    const sum = loose.reduce((s, t) => s + t.amount, 0);
    lines.push(`<button class="attend-row" type="button" data-drill-cat="Uncategorised">
      <b>${loose.length} row${loose.length === 1 ? '' : 's'} not sorted yet</b>
      <span>${viz.fmt(sum)} this month is in no category. Tap to sort.</span>
    </button>`);
  }

  // Only the one worst offender: this is a nudge, not a report.
  const rows = viz.byCategory(out);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const vague = rows.find((r) => VAGUE.test(r.category) && total > 0 && r.total / total >= 0.15);
  if (vague) {
    lines.push(`<button class="attend-row" type="button" data-drill-cat="${escapeHtml(vague.category)}">
      <b>"${escapeHtml(vague.category)}" is ${Math.round((vague.total / total) * 100)}% of the month</b>
      <span>${viz.fmt(vague.total)} under a name that says nothing. Worth splitting into what it really was.</span>
    </button>`);
  }

  box.hidden = !lines.length;
  box.innerHTML = lines.join('');
  if (lines.length) wireDrill(box, month);
}

/**
 * Says, in the console and only on a dev server, when something on the open
 * view is wider than the screen.
 *
 * The views clip sideways overflow now, so a long name can no longer drag the
 * whole page left and right - which also means it can no longer be SEEN
 * doing it. Five grids did exactly that before anyone noticed. This keeps the
 * symptom visible to whoever is working on the app while hiding it from
 * whoever is using it. Anything inside its own sideways scroller is meant to
 * be wider, and is skipped.
 */
function warnIfWiderThanScreen() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  requestAnimationFrame(() => {
    const view = [...document.querySelectorAll('.view')].find(
      (v) => getComputedStyle(v).display !== 'none',
    );
    if (!view) return;
    const limit = view.getBoundingClientRect().right + 1;
    const scrolls = (el) => {
      for (let n = el.parentElement; n && n !== view; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
      return false;
    };
    for (const el of view.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > limit && !scrolls(el)) {
        console.warn(`[layout] wider than the screen by ${Math.round(r.right - limit)}px:`, el);
        return;
      }
    }
  });
}

/* ---- the app's own backups ---------------------------------------------
   Everything the app knows lives in the WebView's storage, which goes with the
   app: an uninstall, a change of signing key, or Android clearing a WebView's
   data wipes it, and "Copy everything" only helps if it was tapped. So on the
   phone the app writes a backup to Download/BudgetTracker once a day by
   itself, through the bridge, where none of those reach. One file holds both
   pages - the tracker's export and Basket's two keys - so a restore is one
   file too. */
const BACKUP_LAST_KEY = 'budget-backup-last';
const BACKUP_KIND = 'budget-tracker-backup';

function backupPayload() {
  return JSON.stringify({
    kind: BACKUP_KIND,
    version: ASSET_BUILD,
    when: new Date().toISOString(),
    tracker: JSON.parse(store.exportJSON()),
    basket: {
      'basket-budget-v1': localStorage.getItem('basket-budget-v1'),
      'basket-receipts-v1': localStorage.getItem('basket-receipts-v1'),
    },
  });
}

/** Writes today's backup; returns the bridge's "ok:<where>" or "err:<why>". */
function backupNow(force = false) {
  if (!window.Android || !window.Android.saveBackup) return 'err:no bridge';
  const today = isoDay(new Date());
  if (!force && localStorage.getItem(BACKUP_LAST_KEY) === today) return 'ok:already today';
  const where = String(window.Android.saveBackup(`budget-backup-${today}.json`, backupPayload()));
  if (where.startsWith('ok:')) localStorage.setItem(BACKUP_LAST_KEY, today);
  return where;
}

/**
 * A chosen backup file, read by Android and handed here. Nothing is touched
 * until the sheet's own button is tapped: a WebView swallows confirm(), and a
 * restore is not something to do on a mis-tap.
 */
window.onBackupRead = (text) => {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    toast('That file is not a backup this app wrote.');
    return;
  }
  if (!data || data.kind !== BACKUP_KIND || !data.tracker) {
    toast('That file is not a backup this app wrote.');
    return;
  }
  const when = data.when ? new Date(data.when).toLocaleString('en-GB') : 'an unknown time';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Restore a backup">
      <h3>Restore this backup?</h3>
      <p class="hint">Written ${escapeHtml(when)} by version ${escapeHtml(String(data.version || '?'))}.
        Transactions, rules and categories merge in; single figures take the file's version;
        Basket's list and receipts are replaced by the file's. The app reloads afterwards.</p>
      <div class="modal-actions">
        <button type="button" class="ghost" id="restore-cancel">Cancel</button>
        <button type="button" id="restore-go">Restore</button>
      </div>
    </div>`;
  overlay.querySelector('#restore-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#restore-go').addEventListener('click', () => {
    const r = store.importJSON(JSON.stringify(data.tracker));
    if (r && r.error) {
      toast(r.error);
      return;
    }
    for (const [key, value] of Object.entries(data.basket || {})) {
      if (typeof value === 'string') localStorage.setItem(key, value);
    }
    overlay.remove();
    location.reload();
  });
  document.body.appendChild(overlay);
};

/* ---- what the phone says when the app is closed --------------------------
   The page cannot run in the background, so this is two things: lines that
   crossed 80% or went over are posted the moment the app sees them (once per
   line per month), and the words for the last day of the month are left with
   Android along with an alarm. Both are as current as the last time the app
   was opened, which is the most a page can honestly offer. */
const NOTIFIED_KEY = 'budget-notified';

function notifyBudgets(report, month, days, to, budgeted, spent) {
  const a = window.Android;
  if (!a || !a.notify) return;
  let done = {};
  try {
    done = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}');
  } catch (e) {
    done = {};
  }
  // Only this month's keys are kept, so the record does not grow forever.
  const keep = {};
  for (const [k, v] of Object.entries(done)) if (k.startsWith(`${month}|`)) keep[k] = v;
  const hash = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) n = (n * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(n) % 100000 + 1000;
  };
  for (const r of report || []) {
    if (!(r.amount > 0)) continue;
    const pct = r.spent / r.amount;
    const stage = pct >= 1 ? 'over' : pct >= 0.8 ? '80' : null;
    if (!stage) continue;
    const key = `${month}|${r.label}|${stage}`;
    if (keep[key]) continue;
    keep[key] = 1;
    const title = stage === 'over'
      ? `${r.label} is over by ${viz.fmt(r.spent - r.amount)}`
      : `${r.label} is at ${Math.round(pct * 100)}%`;
    const text = `${viz.fmt(r.spent)} of ${viz.fmt(r.amount)} \u00b7 ${days} day${days === 1 ? '' : 's'} left in the month`;
    try {
      a.notify(hash(key), title, text);
    } catch (e) {
      /* an older build without the bridge */
    }
  }
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(keep));

  if (a.scheduleReminder && to) {
    const at = Date.parse(`${to}T09:00:00`);
    const text = budgeted > 0
      ? `${viz.fmt(Math.max(0, budgeted - spent))} left of ${viz.fmt(budgeted)}, as of the last time the app was opened.`
      : `${viz.fmt(spent)} spent so far, as of the last time the app was opened.`;
    try {
      a.scheduleReminder(at, 'Last day of your budget month', text);
    } catch (e) {
      /* an older build without the bridge */
    }
  }
}

/** The most recent message that carried a balance, per account. */
function latestBalances() {
  const latest = new Map();
  for (const t of store.allTransactions()) {
    if (t.balance == null || !t.date) continue;
    const acct = t.accountSource || 'mpesa';
    const seen = latest.get(acct);
    if (!seen || t.date > seen.date) latest.set(acct, t);
  }
  return latest;
}

/** A wallet opens its own account; cash opens the pocket. */
function wireWallets(box) {
  const cashBtn = box.querySelector('[data-cash]');
  if (cashBtn) cashBtn.addEventListener('click', () => { renderCash(); showView('cash'); });

  box.querySelectorAll('[data-acct]').forEach((el) => {
    el.addEventListener('click', () => {
      state.drillMonth = null;
      state.drillFrom = null;
      state.drillTo = null;
      state.drillClass = null;
      state.drillCats = null;
      state.drillBudget = null;
      state.catFilter = 'all';
      state.dirFilter = 'all';
      state.search = '';
      state.acctFilter = el.dataset.acct;
      state.txnLimit = 150;
      state.sort = { key: 'date', dir: 'desc' };
      const box2 = $('#search');
      if (box2) box2.value = '';
      render();
      showView('txns');
    });
  });
}

/**
 * Minted only: what you HAVE, above what you have spent.
 *
 * The screen has always led with the budget, which is a target. This leads
 * with the money actually in your hands, which is a fact - and it was four
 * scrolls down in a rail before. The wallets it is made of sit under it and
 * still open their own accounts, so nothing is lost by the rail going.
 *
 * It is only ever as complete as the accounts the app has been told about,
 * which is why it says how many it counted and how old the oldest reading
 * is: one wallet read today does not make a total from last week current.
 */
function renderBalanceTop() {
  const box = $('#bal-top');
  if (!box) return;
  const hide = () => { box.hidden = true; box.innerHTML = ''; };
  if (lookNow() !== 'minted') return hide();

  const today = Date.parse(isoDay(new Date()));
  const parts = [];
  const pocket = pocketNow();
  if (pocket.pocket > 0 || store.cashRuns().length) {
    parts.push({
      name: 'Cash in pocket',
      amount: pocket.pocket,
      icon: emojiOf('cash'),
      attr: 'data-cash="1"',
      days: 0,
      when: pocket.since ? `drawn out since ${shortDate(pocket.since)}` : 'nothing drawn out yet',
    });
  }
  for (const [acct, t] of [...latestBalances().entries()]
    .sort((x, y) => (x[1].date < y[1].date ? 1 : -1))) {
    const days = Math.round((today - Date.parse(t.date.slice(0, 10))) / 86400000);
    parts.push({
      name: ACCOUNT_LABELS[acct] || acct,
      amount: t.balance,
      icon: emojiOf('card'),
      attr: `data-acct="${escapeHtml(acct)}"`,
      days,
      when: days <= 0 ? 'read today'
        : days === 1 ? 'read yesterday'
          : `read ${shortDate(t.date.slice(0, 10))}`,
    });
  }
  if (!parts.length) return hide();

  const total = parts.reduce((sum, w) => sum + w.amount, 0);
  const oldest = Math.max(...parts.map((w) => w.days));
  const counted = `across ${parts.length} wallet${parts.length === 1 ? '' : 's'}`;
  // Each row says its own age, so the line under the total only speaks up
  // when the whole figure is old enough to be worth doubting.
  const sub = oldest > 3 ? `${counted} &middot; oldest reading ${oldest} days old` : counted;
  box.hidden = false;
  // Counted up only on the first drawing of a session - see countUp.
  const arriving = box.dataset.drawn !== '1';
  box.dataset.drawn = '1';
  box.innerHTML = `
    <p class="bt-lab">Money I have</p>
    <p class="bt-big">${arriving ? '0' : viz.fmt(total)}</p>
    <p class="bt-sub">${sub}</p>
    <div class="mrows">${parts.map((w) => `
      <button class="mrow" type="button" ${w.attr}>
        <span class="msq" aria-hidden="true">${w.icon}</span>
        <span class="mtext">
          <span class="mname">${escapeHtml(w.name)}</span>
          <span class="mwhen">${escapeHtml(w.when)}</span>
        </span>
        <span class="mamt">${viz.fmt(w.amount)}</span>
        <span class="mgo" aria-hidden="true">\u203a</span>
      </button>`).join('')}</div>`;
  wireWallets(box);
  if (arriving) countUp(box.querySelector('.bt-big'), total);
  return undefined;
}

function renderBalances() {
  const box = $('#balances');
  if (!box) return;
  const latest = latestBalances();

  const today = Date.parse(isoDay(new Date()));

  // Cash is not read from a message - no one texts you what is in your pocket.
  // It is what is left of the money you have drawn out and not yet accounted
  // for, which is a figure you can check by opening your wallet. That check is
  // the only thing keeping the rest of it honest, so the card invites it.
  const pocket = pocketNow();
  const cashCard = pocket.pocket > 0 || store.cashRuns().length
    ? `<button class="balrow balrow-cash" type="button" data-cash="1">
         <span class="bal-icon bal-icon-cash" aria-hidden="true">
           <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>
           </svg>
         </span>
         <span class="bal-text">
           <span class="bal-name">Cash in pocket</span>
           <span class="bal-when">${pocket.since ? `drawn out since ${shortDate(pocket.since)}` : 'nothing drawn out this cycle'}</span>
         </span>
         <span class="bal-amt">${viz.fmt(pocket.pocket)}</span>
         <span class="bc-go">\u203a</span>
       </button>`
    : '';

  box.innerHTML = cashCard + [...latest.entries()]
    .sort((a, b) => (a[1].date < b[1].date ? 1 : -1))
    .map(([acct, t]) => {
      const days = Math.round((today - Date.parse(t.date.slice(0, 10))) / 86400000);
      // Said plainly: a balance is only as current as the message it came from,
      // and one from three weeks ago is a fact about three weeks ago.
      const when =
        days <= 0 ? 'as of today' : days === 1 ? 'as of yesterday' : `as of ${shortDate(t.date.slice(0, 10))}`;
      const stale = days > 3 ? ' bal-stale' : '';
      return `<button class="balrow${stale}" type="button" data-acct="${escapeHtml(acct)}">
        <span class="bal-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <path d="M3 7V6a2 2 0 0 1 2-2h11"/><circle cx="16.5" cy="13" r="1.2"/>
          </svg>
        </span>
        <span class="bal-text">
          <span class="bal-name">${escapeHtml(ACCOUNT_LABELS[acct] || acct)}</span>
          <span class="bal-when">${when}</span>
        </span>
        <span class="bal-amt">${viz.fmt(t.balance)}</span>
        <span class="bc-go">\u203a</span>
      </button>`;
    })
    .join('');

  wireWallets(box);
}

/** The last seven days as bars, today picked out. */
function renderSpark(all, todayIso) {
  const days = [];
  const base = new Date(`${todayIso}T12:00:00`);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    days.push(isoDay(d));
  }
  const totals = days.map((day) =>
    all
      .filter((t) => t.direction === 'Out' && t.date && t.date.slice(0, 10) === day && classOf(t.category) !== CLASSES.TRANSFER)
      .reduce((a, t) => a + t.amount, 0)
  );
  const peak = Math.max(...totals, 1);
  const letters = days.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'narrow' }));
  $('#spark7').innerHTML = totals
    .map((v, i) => `<i class="${i === 6 ? 'today' : ''}" style="height:${Math.max(2, (v / peak) * 100)}%" title="${escapeHtml(days[i])}: ${viz.fmt(v)}"></i>`)
    .join('');
  $('#spent-today').textContent = viz.fmt(totals[6]);
  const week = totals.reduce((a, v) => a + v, 0);
  $('#spent-today-note').textContent = week ? `${viz.fmt(week)} over the week` : 'nothing yet';

  const cards = document.querySelectorAll('.duo .duo-card');
  // These two count spending as well, so they narrow the same way.
  wireBehind(cards[0], () => ({ from: days[0], to: days[6], dir: 'Out', spending: true, label: 'The last seven days' }));
  wireBehind(cards[1], () => ({ from: days[6], to: days[6], dir: 'Out', spending: true, label: 'Today' }));
  const strip = $('#spark-days');
  if (strip) strip.innerHTML = letters.map((l) => `<span>${escapeHtml(l)}</span>`).join('');
}

/*
 * A picture for each budget line.
 *
 * Minted draws the lines as tiles, and a tile needs something in the middle of
 * its dial. There is no icon set in here and no room to add one, so these are
 * emoji: they come with the phone, they cost nothing, and they are the one
 * thing on the screen that is recognised before it is read. Matched on words
 * in the line's own NAME, so a budget called "Shopping & gifts" still finds
 * one and a renamed line does not go blank.
 */
/**
 * The four biggest categories of the cycle, listed under the ring.
 *
 * The ring answers "how much OF it"; a figure you can read answers "how
 * much". They are rows with a hairline between them rather than a card each:
 * four cards is four boxes doing the work of one list, and the ring beside
 * them is already as much furniture as the screen can carry. The icon takes
 * its slice's colour at a whisper, which is the whole of the decoration.
 */
function renderHeroCats(rows, slotOf, glyphs, month) {
  const box = $('#hero-cats');
  if (!box) return;
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  if (!rows.length || total <= 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = rows.slice(0, 4).map((r) => {
    const pct = r.total / total;
    const colour = viz.seriesColour(slotOf(r.category));
    // The folded row stands for several categories, so it opens all of them.
    const opens = r.rest
      ? `data-drill-cats="${escapeHtml(r.rest.join('|'))}" data-drill-label="${escapeHtml(r.category)}"`
      : `data-drill-cat="${escapeHtml(r.category)}"`;
    return `<button class="mrow" type="button" ${opens}>
      <span class="msq" aria-hidden="true" style="background:${colour}1f">
        ${emojiOf(glyphs[r.category] || glyphFor(r.category))}</span>
      <span class="mtext">
        <span class="mname">${escapeHtml(r.category)}</span>
        <span class="mwhen">${Math.round(pct * 100)}% of the month</span>
      </span>
      <span class="mamt">${viz.fmt(r.total)}</span>
      <span class="mgo" aria-hidden="true">\u203a</span>
    </button>`;
  }).join('');
  wireDrill(box, month);
}

/** The little ring around a tile's icon: how far through the line you are. */
function tileDial(pct, colour) {
  const R = 16;
  const C = 2 * Math.PI * R;
  const on = Math.max(0, Math.min(1, pct)) * C;
  return `<svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="${R}" fill="none" stroke="var(--track)" stroke-width="3.5"/>
      <circle cx="20" cy="20" r="${R}" fill="none" stroke="${colour}" stroke-width="3.5"
              stroke-linecap="round" stroke-dasharray="${on} ${C - on}"
              transform="rotate(-90 20 20)"/>
    </svg>`;
}

/** Each budget line as a card: what is left, and how far through it you are. */
function renderHomeBudgets(report, budgeted, month) {
  const box = $('#home-budgets');
  const sec = $('#home-budgets-sec');
  const lines = (report || []).filter((r) => r.amount > 0);
  sec.hidden = !lines.length;
  if (!lines.length) {
    box.innerHTML = '';
    return;
  }
  // Worst first: a line you have blown through is the one worth seeing.
  const mint = lookNow() === 'minted';
  const rows = lines
    .slice()
    .sort((a, b) => b.spent / b.amount - a.spent / a.amount)
    .slice(0, mint ? 6 : 4);
  box.classList.toggle('tiles', mint);
  // Biggest trouble first, so the line most worth reading keeps its own icon.
  const tileGlyphs = glyphMap(rows.map((r) => r.label));
  box.innerHTML = rows
    .map((r) => {
      const left = r.amount - r.spent;
      const pct = Math.min(100, (r.spent / r.amount) * 100);
      const over = left < 0;
      // The card shows a figure, so it opens what the figure counted - the
      // categories this line covers, in the month it is counting. It used to
      // go to the budget SETTINGS, which is where you change the 35,000, not
      // where you find out what the 29,150 was spent on.
      const covers = Array.isArray(r.categories) ? r.categories.filter(Boolean) : [];
      const opens = covers.length
        ? `data-drill-cats="${escapeHtml(covers.join('|'))}" data-drill-label="${escapeHtml(r.label)}"` +
          ` data-drill-budget="${escapeHtml(r.id)}"`
        : 'data-go="budget"'; // a line with nothing mapped has nothing to show
      if (mint) {
        // The dial takes its colour from where the ring takes its slice's, so
        // a hue means one thing on the whole screen.
        const cat = covers[0];
        const colour = cat ? viz.seriesColour(store.chartSlots([cat])[cat] ?? 7) : 'var(--tint)';
        return `<button class="btile${over ? ' over' : ''}" type="button" ${opens}>
          <span class="bt-dial">${tileDial(r.spent / r.amount, over ? 'var(--bad)' : colour)}
            <em>${emojiOf(tileGlyphs[r.label] || glyphFor(r.label))}</em></span>
          <span class="bt-text">
            <span class="bt-name">${escapeHtml(r.label)}</span>
            <span class="bt-amt">${viz.fmt(r.spent)}</span>
            <span class="bt-of">of ${viz.fmt(r.amount)}</span>
          </span>
        </button>`;
      }
      return `<button class="bcard" type="button" ${opens}>
        <span class="bc-icon ${over ? 'neg' : ''}" aria-hidden="true">${over ? '!' : '●'}</span>
        <span class="bc-text">
          <span class="bc-name">${escapeHtml(r.label)}</span>
          <span class="bc-sub">${over ? `${viz.fmt(-left)} over` : `${viz.fmt(left)} left to spend`}</span>
        </span>
        <span class="bc-fig">
          <span class="bc-amt">${viz.fmt(r.spent)}</span>
          <span class="bc-of">of ${viz.fmt(r.amount)}</span>
        </span>
        <span class="bc-go">›</span>
        <span class="bc-bar"><i class="${over ? 'over' : ''}" style="width:${pct}%"></i></span>
      </button>`;
    })
    .join('');
  wireDrill(box, month);
  wireViewLinks(box);
}

/** What is due next, from the payments that repeat every month. */
function renderHomeUpcoming(all) {
  const box = $('#home-upcoming');
  const sec = $('#home-upcoming-sec');
  // A lender that has said a loan of its is finished stops being predicted,
  // unless it has been paid again since - borrowing again starts a new one.
  // Written `\\b`, because in a template literal `\b` is a backspace character
  // and the regex then matches nothing at all, silently.
  const settled = Object.entries(store.settlements());
  const stillOwed = (r) =>
    settled.every(([lender, when]) => {
      if (!new RegExp(`\\b${lender}\\b`, 'i').test(r.name)) return true;
      // Paid again since it was settled: he borrowed again, so it is live.
      return String(r.last || '').slice(0, 10) > when;
    });
  const found = findRecurring(all).filter((r) => !r.stale && r.nextDue && stillOwed(r));
  const soon = found
    .slice()
    .sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1))
    .slice(0, 4);
  sec.hidden = !soon.length;
  if (!soon.length) {
    box.innerHTML = '';
    return;
  }
  const today = isoDay(new Date());
  box.innerHTML = soon
    .map((r) => {
      const inDays = Math.round((Date.parse(r.nextDue) - Date.parse(today)) / 86400000);
      const when = inDays < 0 ? 'overdue' : inDays === 0 ? 'today' : inDays === 1 ? 'tomorrow' : `in ${inDays} days`;
      return `<button class="bcard" type="button" data-due="${escapeHtml(r.name)}">
        <span class="bc-icon" aria-hidden="true">↻</span>
        <span class="bc-text">
          <span class="bc-name">${escapeHtml(r.name)}</span>
          <span class="bc-sub">${escapeHtml(shortDate(r.nextDue.slice(0, 10)))} · ${when}</span>
        </span>
        <span class="bc-fig"><span class="bc-amt">${viz.fmt(r.typical)}</span></span>
        <span class="bc-go">›</span>
      </button>`;
    })
    .join('');
  box.querySelectorAll('[data-due]').forEach((el) => {
    wireBehind(el, () => ({
      search: el.dataset.due,
      dir: 'Out',
      label: `Every payment to ${el.dataset.due}`,
    }));
  });
}

/* ---- Back closes what is open --------------------------------------------- */
//
// The phone's back gesture asks the page before it leaves the screen, but only
// when the page has said something is open. Nothing here ever said so, so back
// went a screen back with the category picker still over the top of it.
//
// Overlays are FOUND rather than registered: every dialog already on this page
// is covered without being touched, and so is the next one somebody adds.

/** Everything floating over the page right now, in the order back should eat it. */
function openOverlays() {
  const shown = (el) => el && !el.hidden && getComputedStyle(el).display !== 'none';
  return [
    $('#catpick'), // opened over the dialogs, so it closes first
    ...document.querySelectorAll('.modal-overlay:not(#catpick)'),
    $('#menu'),
  ].filter(shown);
}

function tellAndroidAboutOverlays() {
  try {
    if (window.Android && window.Android.setSheetOpen) {
      window.Android.setSheetOpen(openOverlays().length > 0);
    }
  } catch (e) {
    /* an older build without the bridge */
  }
}

function wireBackOverlays() {
  // Android calls this and goes back itself only if it returns false.
  window.bbCloseSheet = () => {
    const open = openOverlays();
    if (!open.length) return false;
    const top = open[0];

    if (top.id === 'catpick') closeCategoryPicker(null);
    else if (top.id === 'menu') $('#menu-scrim').click();
    else {
      // A dialog's own close button knows what else to put back; only when
      // there isn't one does this just hide the thing.
      const close = top.querySelector('.pick-close, [data-cancel-pick], [data-offcancel]');
      if (close) close.click();
      else top.hidden = true;
    }
    tellAndroidAboutOverlays();
    return true;
  };

  // `hidden` is how every one of them is shown and hidden, so watching that
  // attribute keeps Android in step without each dialog having to remember to.
  new MutationObserver(tellAndroidAboutOverlays).observe(document.body, {
    attributes: true,
    attributeFilter: ['hidden'],
    subtree: true,
  });
  tellAndroidAboutOverlays();
}

/* ---- Choosing a category -------------------------------------------------- */
//
// A phone's own <select> picker is thirty-odd rows of scrolling with no way to
// type, and this is the control the whole app is built around - it gets used
// more than everything else put together. So the native one is intercepted and
// a searchable list opened instead, over the top of the same <select>: the
// element keeps its value and still fires `change`, so every handler that was
// listening carries on working and nothing downstream had to know.

let pickResolve = null;
let pickDraw = null;

/** Categories ordered by how much you actually use them, commonest first. */
function categoriesByUse() {
  const counts = new Map();
  // Decorated, not raw: a transaction only has a category once the rules have
  // been run over it, and reading the raw rows gave an empty list every time.
  for (const t of decorate(visible())) {
    if (!t.category) continue;
    counts.set(t.category, (counts.get(t.category) || 0) + 1);
  }
  return counts;
}

function openCategoryPicker(sel) {
  const box = $('#catpick');
  const list = $('#catpick-list');
  const search = $('#catpick-search');
  const current = sel.value;

  // The select's own options when it has a full set of its own (the filter has
  // an "All categories" row the registry knows nothing about); the registry
  // otherwise, because a row's picker is only filled when it is touched.
  const options =
    sel.options.length > 1
      ? [...sel.options].map((o) => ({ value: o.value, label: o.textContent }))
      : Object.keys(CATEGORIES).map((c) => ({ value: c, label: c }));

  // What this particular payment looks like. The picker knows which row it was
  // opened from, so it can lead with a guess instead of thirty categories in
  // alphabetical order - CARRERFOUR MEGA 6 is plainly a shop, and saying so
  // costs a tap to dismiss and saves a scroll to accept.
  let guess = null;
  if (current === 'Uncategorised' || !current) {
    const id = sel.dataset.id;
    const row = id && store.getState().transactions[id];
    const name = row ? row.counterparty : sel.dataset.name;
    const limit = Number(store.settings().smallSendLimit) || 200;
    guess = guessFor(name, row ? row.amount : 0, limit);
    if (guess && !options.some((o) => o.value === guess.category)) guess = null;
  }

  const counts = categoriesByUse();
  const used = options
    .filter((o) => counts.get(o.value) && o.value !== current)
    .sort((a, b) => counts.get(b.value) - counts.get(a.value))
    .slice(0, 5);

  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    const hit = (o) => o.label.toLowerCase().includes(needle);
    const matched = needle ? options.filter(hit) : options;
    const top = needle ? [] : used.filter((o) => !guess || o.value !== guess.category);

    const row = (o) =>
      `<button type="button" class="pick-row${o.value === current ? ' is-on' : ''}" data-pick="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`;

    const head = [];
    if (!needle && guess) {
      head.push(
        `<p class="catpick-head">Looks like</p>`,
        `<button type="button" class="pick-row pick-guess" data-pick="${escapeHtml(guess.category)}">
           <strong>${escapeHtml(guess.category)}</strong><span>${escapeHtml(guess.why)}</span>
         </button>`
      );
    }
    if (top.length) head.push(`<p class="catpick-head">Most used</p>`, top.map(row).join(''));
    if (head.length) head.push(`<p class="catpick-head">Everything</p>`);

    list.innerHTML = matched.length
      ? head.join('') + matched.map(row).join('')
      : `<p class="catpick-none">Nothing matches “${escapeHtml(q)}”.</p>`;
  };

  pickDraw = draw;
  draw('');
  search.value = '';
  box.hidden = false;
  // Not focused on a phone: the keyboard would cover the list, and most picks
  // are a tap on one of the five at the top rather than anything typed.
  if (window.matchMedia('(min-width: 760px)').matches) search.focus();

  return new Promise((resolve) => {
    pickResolve = resolve;
  });
}

function closeCategoryPicker(value) {
  $('#catpick').hidden = true;
  pickDraw = null;
  const done = pickResolve;
  pickResolve = null;
  if (done) done(value || null);
}

/** Every category dropdown in the app, wherever it lives. */
const CATEGORY_SELECTS =
  'select.cat, select.triage-cat, #cat-filter, #bulk-cat, #nr-cat, #pad-cat, select.budget-assign';

function wireCategoryPicker() {
  const box = $('#catpick');

  $('#catpick-search').addEventListener('input', (e) => {
    if (pickDraw) pickDraw(e.target.value);
  });

  $('#catpick-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    closeCategoryPicker(b.dataset.pick);
  });
  $('#catpick-close').addEventListener('click', () => closeCategoryPicker(null));
  box.addEventListener('click', (e) => {
    if (e.target === box) closeCategoryPicker(null);
  });

  // Why a click and not a touch: suppressing the phone's own picker means
  // cancelling the touch that would open it, and a cancelled touch on a list
  // cannot scroll either - so dragging past a row opened its categories. The
  // selects are made untouchable in CSS instead, which lets the finger scroll
  // the list underneath them, and the CLICK that only fires when you did not
  // scroll is what opens ours.
  const intercept = (e) => {
    // A tap inside the picker is a choice, not a request to open one. Without
    // this it would look under the overlay, find whatever row happens to sit
    // beneath the list, and open that row's categories instead.
    if (e.target.closest && e.target.closest('#catpick')) return;
    // The select takes no pointer events, so the click lands on whatever is
    // behind it - its own container. Finding it again means looking inside
    // that container for a category dropdown the click actually landed on.
    // (elementsFromPoint cannot do it: hit testing skips pointer-events: none,
    // which is the very thing that lets the list scroll under the finger.)
    const over = (el) => {
      const r = el.getBoundingClientRect();
      // A select that has just left the page has a rect of nothing, at (0,0) -
      // and a click fired from the keyboard, or by a script, carries the
      // coordinates (0,0). The two met when Save on a dialog closed it: the
      // walk up from the now-detached button found the dialog's own select,
      // which "contained" the point, and the picker opened over a screen that
      // had not asked for it.
      if (!el.isConnected || !r.width || !r.height) return false;
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    let sel = null;
    for (let node = e.target; node && node !== document && !sel; node = node.parentElement) {
      sel = [...node.querySelectorAll(CATEGORY_SELECTS)].find(over) || null;
      if (node.classList && node.classList.contains('view')) break; // far enough
    }
    if (!sel || sel.disabled) return;
    e.preventDefault();
    openCategoryPicker(sel).then((value) => {
      if (value == null || value === sel.value) return;
      // The option may not be in this select yet (a row's picker holds only its
      // own category until it is touched), so put it there before setting it.
      if (![...sel.options].some((o) => o.value === value)) {
        sel.add(new Option(value, value));
      }
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  document.addEventListener('click', intercept, true);
}

/* ---- Cash ---------------------------------------------------------------- */

// What the pad is holding before it is saved. It lives out here because the pad
// stays open across items - that is the whole design - so it cannot be state
// that a render rebuilds.
const pad = { amount: '', items: [], category: 'Groceries', date: null };

function renderCash() {
  const pocket = pocketNow();
  $('#cash-pocket').textContent = viz.fmt(pocket.pocket);
  $('#cash-since').textContent = pocket.since
    ? `from what you have drawn out since ${shortDate(pocket.since)}`
    : 'nothing drawn out this cycle that is still unaccounted for';

  // Cash from cycles that have closed. It is already counted as spending in the
  // month it was drawn; this only says how much of your spending has no
  // description against it.
  const lap = $('#cash-lapsed');
  lap.hidden = !pocket.lapsed;
  if (pocket.lapsed) {
    lap.textContent =
      `${viz.fmt(pocket.lapsed)} was drawn out in earlier cycles and never itemised. ` +
      'It counts as spending in the month it was drawn — this is just how much of it has no description.';
  }

  // Cash spent that no withdrawal covers. Usually change or a gift, occasionally
  // a withdrawal the app has not read - either way, saying so beats a figure
  // that quietly does not add up.
  const un = $('#cash-unmatched');
  un.hidden = pocket.unmatched <= 0;
  if (pocket.unmatched > 0) {
    un.textContent =
      `${viz.fmt(pocket.unmatched)} of what you typed is not covered by any withdrawal the app has read — ` +
      'cash from change or a gift, most likely. It is listed below but counts toward nothing.';
  }

  const gifts = [...store.cashIn()].sort((x, y) => (x.date < y.date ? 1 : -1));
  const gbox = $('#cash-gifts');
  if (gbox) {
    gbox.innerHTML = !gifts.length ? '' : `<h3 class="cash-sec">Cash you were given</h3>${gifts
      .map((g) => `<div class="card cashrun">
        <div class="cr-line">
          <div class="cr-grow">
            <div class="cr-name">${escapeHtml(g.note || 'Cash in hand')}</div>
            <div class="cr-sub">${shortDate(g.date)}</div>
          </div>
          <div class="cr-amt">${viz.fmt(g.amount)}</div>
          <button class="cr-x" type="button" data-del-gift="${escapeHtml(g.id)}" aria-label="Remove">&times;</button>
        </div>
      </div>`)
      .join('')}`;
    gbox.querySelectorAll('[data-del-gift]').forEach((el) => {
      el.addEventListener('click', () => {
        store.removeCashIn(el.dataset.delGift);
        render();
        renderCash();
      });
    });
  }

  const runs = [...store.cashRuns()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const box = $('#cash-runs');
  if (!runs.length) {
    box.innerHTML =
      '<p class="hint">Nothing itemised yet. Every withdrawal still reads as one lump — ' +
      'adding what it went on does not change what you have spent, only what the app can tell you about it.</p>';
    return;
  }

  box.innerHTML = runs
    .map((r) => {
      const items = (r.items || []).map((i) => `${escapeHtml(i.name)} ${viz.fmt(i.amount)}`).join(' · ');
      return `<div class="card cashrun">
        <div class="cr-line">
          <div class="cr-grow">
            <div class="cr-name">${escapeHtml(r.category)}</div>
            <div class="cr-sub">${shortDate(r.date)}${r.items && r.items.length ? ` · ${r.items.length} item${r.items.length === 1 ? '' : 's'}` : ''}</div>
          </div>
          <div class="cr-amt">${viz.fmt(r.amount)}</div>
          <button class="cr-x" type="button" data-del="${escapeHtml(r.id)}" aria-label="Remove">&times;</button>
        </div>
        ${items ? `<div class="cashrun-items">${items}</div>` : ''}
      </div>`;
    })
    .join('');

  box.querySelectorAll('[data-del]').forEach((el) => {
    el.addEventListener('click', () => {
      store.removeCashRun(el.dataset.del);
      render();
      renderCash();
    });
  });
}

function renderPad() {
  $('#pad-amount').textContent = pad.amount ? viz.fmt(Number(pad.amount)) : '0';
  const total = pad.items.reduce((a, i) => a + i.amount, 0);
  $('#pad-save').textContent = total ? `Done · ${viz.fmt(total)}` : 'Done';
  $('#pad-save').disabled = !total && !pad.amount;

  $('#pad-list').innerHTML = pad.items.length
    ? `<div class="card" style="padding:4px 12px 8px">${pad.items
        .map(
          (i, n) =>
            `<div class="cr-line padline"><div class="cr-grow">${escapeHtml(i.name)}</div>` +
            `<div class="cr-amt">${viz.fmt(i.amount)}</div>` +
            `<button class="cr-x" type="button" data-rm="${n}" aria-label="Remove">&times;</button></div>`
        )
        .join('')}</div>`
    : '<p class="hint">Type an amount, then tap what it was. It stays open for the next one.</p>';

  $('#pad-list')
    .querySelectorAll('[data-rm]')
    .forEach((el) =>
      el.addEventListener('click', () => {
        pad.items.splice(Number(el.dataset.rm), 1);
        renderPad();
      })
    );

  const chips = cash.frequentItems(store.cashRuns(), 8);
  const seed = ['Kale', 'Tomatoes', 'Potatoes', 'Onions', 'Milk', 'Matatu'];
  const list = chips.length >= 4 ? chips : [...chips, ...seed.filter((x) => !chips.includes(x))].slice(0, 8);
  $('#pad-chips').innerHTML = list
    .map((n) => `<button type="button" data-chip="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
    .join('');
  $('#pad-chips')
    .querySelectorAll('[data-chip]')
    .forEach((el) => el.addEventListener('click', () => commitItem(el.dataset.chip)));
}

/** Put the typed amount down against a name and clear the keypad for the next one. */
function commitItem(name) {
  const amount = Number(pad.amount);
  if (!amount || !name.trim()) return;
  pad.items.push({ name: name.trim(), amount });
  pad.amount = '';
  $('#pad-name').value = '';
  renderPad();
}

function openPad() {
  pad.amount = '';
  pad.items = [];
  pad.date = isoDay(new Date());
  const sel = $('#pad-cat');
  sel.innerHTML = cash
    .cashCategories()
    .map((c) => `<option${c === pad.category ? ' selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');
  $('#pad-date').value = pad.date;
  renderPad();
  showView('pad');
}

function wireCash() {
  $('#btn-cash-add').addEventListener('click', openPad);

  const countCard = $('#cash-count');
  $('#btn-cash-count').addEventListener('click', () => {
    countCard.hidden = !countCard.hidden;
    if (!countCard.hidden) {
      $('#cash-counted').value = '';
      $('#cash-count-says').textContent = '';
      $('#cash-counted').focus();
    }
  });

  const givenCard = $('#cash-given');
  $('#btn-cash-given').addEventListener('click', () => {
    givenCard.hidden = !givenCard.hidden;
    if (!givenCard.hidden) {
      $('#cash-given-amt').value = '';
      $('#cash-given-note').value = '';
      $('#cash-given-date').value = isoDay(new Date());
      $('#cash-given-amt').focus();
    }
  });
  $('#btn-cash-given-save').addEventListener('click', () => {
    const row = store.addCashIn({
      amount: Number($('#cash-given-amt').value),
      date: $('#cash-given-date').value,
      note: $('#cash-given-note').value,
    });
    if (!row) {
      toast('Put in how much you were given.');
      return;
    }
    givenCard.hidden = true;
    render();
    renderCash();
    toast(`${viz.fmt(row.amount)} added to your pocket. Nothing else changes.`);
  });

  $('#btn-cash-counted').addEventListener('click', () => {
    const counted = Number($('#cash-counted').value);
    if (!Number.isFinite(counted) || counted < 0) return;
    const pocket = pocketNow();
    const gap = Math.round(pocket.pocket - counted);
    if (gap === 0) {
      $('#cash-count-says').textContent = 'It matches. Nothing to record.';
      return;
    }
    if (gap < 0) {
      // More than the app knows about. Inventing a withdrawal to cover it would
      // put money into the totals that never passed through any account, so it
      // is said out loud and left alone.
      $('#cash-count-says').textContent =
        `You have ${viz.fmt(-gap)} more than the app can account for. That cash came from somewhere ` +
        'it has never seen — change, or a gift — so it is not added to any total.';
      return;
    }
    store.addCashRun({
      date: isoDay(new Date()),
      category: cash.UNACCOUNTED_CATEGORY,
      items: [{ name: 'Counted short', amount: gap }],
    });
    render();
    renderCash();
    countCard.hidden = true;
    toast(`${viz.fmt(gap)} recorded as cash spent without a record.`);
  });

  $('#pad-cat').addEventListener('change', (e) => {
    pad.category = e.target.value;
  });
  $('#pad-date').addEventListener('change', (e) => {
    pad.date = e.target.value || isoDay(new Date());
  });

  $('#pad-keys').addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]');
    if (!k) return;
    const key = k.dataset.k;
    if (key === 'del') pad.amount = pad.amount.slice(0, -1);
    else if (pad.amount.length < 7) pad.amount = (pad.amount + key).replace(/^0+(?=\d)/, '');
    renderPad();
  });

  $('#pad-add').addEventListener('click', () => commitItem($('#pad-name').value));
  $('#pad-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitItem($('#pad-name').value);
  });

  $('#pad-save').addEventListener('click', () => {
    // An amount typed but never named is still money spent, so it is kept rather
    // than thrown away for want of a label.
    if (pad.amount) commitItem('Cash');
    if (!pad.items.length) return;
    const run = store.addCashRun({ date: pad.date, category: pad.category, items: pad.items });
    if (!run) return;
    render();
    renderCash();
    showView('cash');
    toast(`${viz.fmt(run.amount)} itemised against your cash.`);
  });
}

function renderHome(all) {
  const now = new Date();
  const todayIso = isoDay(now);
  // Which month today belongs to - the same question the reports ask of every
  // transaction, so the answer is the same resolver.
  const month = monthResolver(all)({ date: `${todayIso}T12:00:00` }) || todayIso.slice(0, 7);
  const { report, budgeted, spent, outside, cycleStart } = budgetReport(store.budgets(), all, month);
  const { from, to } = cycleBounds(all, cycleStart, todayIso);

  const name = (store.settings().name || '').trim();
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#home-greet').textContent = name ? `${part}, ${name}` : part;
  $('#home-today').textContent = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const days = Math.max(0, Math.round((Date.parse(to) - Date.parse(todayIso)) / 86400000));
  $('#hero-cycle').textContent = `${monthLabel(month)} · ${shortDate(from)} – ${shortDate(to)}`;

  // The ring. Its path is a 180° arc of radius 90, so it is π × 90 ≈ 283 long;
  // 424 is the dash cycle the stylesheet declares, which leaves the remainder as
  // the gap. Filling it by share rather than by amount is what lets a 5k budget
  // and a 50k one read the same way.
  const ARC = 283;
  const fillEl = $('#gauge-fill');
  const stateEl = $('#hero-state');
  const share = budgeted > 0 ? spent / budgeted : 0;
  fillEl.style.strokeDasharray = `${Math.min(1, share) * ARC} 424`;
  fillEl.classList.toggle('over', share > 1);

  if (budgeted > 0) {
    const left = budgeted - spent;
    $('#hero-left').textContent = viz.fmt(Math.abs(left));
    $('#hero-sub').textContent =
      left >= 0 ? `left of ${viz.fmt(budgeted)}` : `over ${viz.fmt(budgeted)}`;
    // A share of the month against a share of the money: being 80% through the
    // budget on day 3 and on day 28 are not the same news.
    const elapsed = (Date.parse(todayIso) - Date.parse(from)) / (Date.parse(to) - Date.parse(from) || 1);
    stateEl.textContent =
      left < 0
        ? `Over by ${viz.fmt(-left)}`
        : share <= elapsed + 0.05
          ? 'On track'
          : `Going fast — ${viz.fmt(left)} left for ${days} day${days === 1 ? '' : 's'}`;
    stateEl.classList.toggle('over', left < 0);
  } else {
    // No budget yet. Showing "0 left of 0" would be a confident lie, so the
    // card answers the question it still can: what has gone out this month.
    $('#hero-left').textContent = viz.fmt(spent + outside);
    $('#hero-sub').textContent = 'spent this month';
    stateEl.textContent = 'Set a budget to see what is left';
    stateEl.classList.remove('over');
  }

  // The three chips use the same month ASSIGNMENT as the gauge above them, not
  // a date range of their own. Two definitions of "this month" on one card is
  // how it came to show 612,370 and 51,354 at the same time, both labelled
  // spent, both honest about a different question.
  const monthOf = monthResolver(all);
  const cycle = all.filter((t) => monthOf(t) === month);
  const cs = viz.summarise(cycle);

  // Minted draws this cycle as a ring of categories with the figure above in
  // the middle of it, instead of the arc: the same share of the budget, plus
  // the shape of what it went on, in the space the arc was using anyway.
  const mint = lookNow() === 'minted';
  const ringBox = $('#hero-ring');
  if (ringBox) {
    if (mint) {
      const hrows = viz.donutRows(viz.byCategory(cycle));
      // "Everything else" is asked for by name, because the ring may fold thin
      // slices into it after this point - and a slice with no slot of its own
      // fell back to slot 7, which is where it came out the same red as the
      // category already sitting there.
      const hslots = store.chartSlots([...hrows.map((r) => r.category), viz.REST_LABEL]);
      // Resolved over the whole ring at once, so two slices never share one.
      const hglyphs = glyphMap(hrows.map((r) => r.category));
      // Nothing is written on the ring: the names are in the list under it,
      // so the circle can be as big as the card and nothing can collide with
      // it. Leader lines were tried and dropped - they were the only part of
      // this screen that broke every time a category was renamed.
      // The same once-a-session rule as the balance above it.
      const arriving = ringBox.dataset.drawn !== '1';
      ringBox.dataset.drawn = '1';
      viz.renderDonut(ringBox, hrows, (c) => hslots[c] ?? 7, {
        middle: false,
        legend: false,
        hero: true,
        grow: arriving,
      });
      wireDrill(ringBox, month);
      renderHeroCats(hrows, (c) => hslots[c] ?? 7, hglyphs, month);
    } else {
      ringBox.innerHTML = '';
      renderHeroCats([], null, null, month);
    }
  }
  if (mint && budgeted > 0) {
    // The ring counts spending, so the figure inside it counts spending too.
    // What is LEFT moves to the line under the list, where it reads as the
    // note it is instead of competing with the balance at the top.
    $('#hero-left').textContent = viz.fmt(spent);
    $('#hero-sub').textContent = `of ${viz.fmt(budgeted)} budgeted`;
  }

  // Where the cycle has got to, against where the money has got to. Only
  // minted shows it: the standard look says the same thing in the arc.
  const bar = document.querySelector('.hero-bar');
  if (bar) {
    bar.hidden = !mint || budgeted <= 0;
    const gone = (Date.parse(todayIso) - Date.parse(from)) / (Date.parse(to) - Date.parse(from) || 1);
    bar.style.setProperty('--today', `${Math.max(0, Math.min(1, gone)) * 100}%`);
    $('#hero-fill').style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
    $('#hero-fill').classList.toggle('over', share > 1);
  }
  $('#chip-spent').textContent = viz.fmt(cs.realSpend);
  $('#chip-in').textContent = viz.fmt(cs.income);
  $('#chip-days').textContent = days === 0 ? 'Last' : days;
  $('#chip-days-label').textContent = days === 1 ? 'Day left' : 'Days left';

  renderAttention(cycle, month);
  warnIfWiderThanScreen();

  // Every figure on this card opens what it counted.
  const labelNow = monthLabel(month);
  wireBehind(document.querySelector('.gauge-card'), () => ({
    month,
    dir: 'Out',
    spending: true,
    label: `Spending in ${labelNow}`,
  }));
  wireBehind($('#chip-in') && $('#chip-in').closest('.chip'), () => ({
    month,
    dir: 'In',
    label: `Money in during ${labelNow}`,
  }));

  // Hand the home-screen widget what it cannot work out for itself. The note
  // carries the budget when there is one and the cycle's dates when there is
  // not, because "51,554" on its own is a number without a question.
  try {
    if (window.Android && window.Android.setSpendSummary) {
      const used = budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0;
      const note =
        budgeted > 0
          ? `${viz.fmt(Math.abs(budgeted - spent))} ${spent > budgeted ? 'over' : 'left'} \u00b7 ${days} day${days === 1 ? '' : 's'} to go`
          : `${shortDate(from)} \u2013 ${shortDate(to)} \u00b7 ${days} day${days === 1 ? '' : 's'} to go`;
      window.Android.setSpendSummary(viz.fmt(spent + outside), note, used);
    }
    notifyBudgets(report, month, days, to, budgeted, spent);
    // The day's backup, once the home screen has drawn: everything it needs
    // is on file by then, and it is cheap.
    setTimeout(() => backupNow(), 3000);
  } catch (e) {
    /* an older build without the bridge */
  }

  renderBalanceTop();
  renderBalances();
  renderSpark(all, todayIso);
  renderHomeBudgets(report, budgeted, month);
  renderHomeUpcoming(all);
  renderBasketRow();
  publishGlance(month, from, to, budgeted, spent, report.find((r) => r.id === 'food'));
}

/** What Basket itself says is in the trolley. It writes this; here it is read. */
function basketGlance() {
  try {
    return JSON.parse(localStorage.getItem(BASKET_GLANCE) || 'null');
  } catch (e) {
    return null;
  }
}

function renderBasketRow() {
  const glance = basketGlance();
  const kept = store.receipts().length;
  const bits = [];
  if (glance && glance.items) bits.push(`${glance.items} in the trolley`);
  bits.push(kept ? `${kept} receipt${kept === 1 ? '' : 's'} kept` : 'scan a receipt');
  $('#bskt-sub').textContent = bits.join(' · ');
  $('#bskt-total').textContent = glance && glance.total > 0 ? viz.fmt(glance.total) : '';
}

/**
 * The Groceries line, written where Basket can read it.
 *
 * Basket shows what is left to spend on food this month, and that figure has
 * to count every shop M-PESA paid for - not only the slips that were scanned.
 * Working that out needs this page's whole pipeline, so it is computed once
 * here rather than approximated twice.
 */
function publishGlance(month, from, to, budgeted, spent, groceries) {
  try {
    localStorage.setItem(
      TRACKER_GLANCE,
      JSON.stringify({
        at: new Date().toISOString(),
        month,
        cycleFrom: from,
        cycleTo: to,
        totalBudget: budgeted,
        totalSpent: spent,
        groceriesBudget: groceries ? groceries.amount : 0,
        groceriesSpent: groceries ? groceries.spent : 0,
      })
    );
  } catch (e) {
    /* Private browsing, or a full quota. The page still works. */
  }
}

/**
 * Takes in the receipts Basket has saved on this device.
 *
 * Both pages are served from one origin now, which is the whole reason for
 * merging them: no clipboard, no "Copy everything", nothing to remember. Each
 * id is taken once, so a receipt deleted here does not come back on the next
 * load.
 */
function pullBasketReceipts() {
  let saved = null;
  let pulled = [];
  try {
    saved = JSON.parse(localStorage.getItem(BASKET_RECEIPTS) || 'null');
    pulled = JSON.parse(localStorage.getItem(BASKET_PULLED) || '[]');
  } catch (e) {
    return 0;
  }
  if (!Array.isArray(saved) || !saved.length) return 0;
  const already = new Set(Array.isArray(pulled) ? pulled : []);

  const fresh = saved
    .filter((r) => r && r.date && Array.isArray(r.items) && !already.has(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      date: String(r.date).slice(0, 10),
      slipTotal: r.slipTotal == null ? null : +r.slipTotal,
      items: r.items.map((i) => ({
        name: String(i.name || 'Item'),
        qty: Math.max(1, +i.qty || 1),
        price: +i.price || 0,
      })),
    }));
  if (!fresh.length) return 0;

  store.importReceipts(fresh);
  // Match each shop to the payment that settled it, as the paste route does.
  store.setReceiptLinks(basket.matchAll(store.receipts(), store.allTransactions()));
  try {
    localStorage.setItem(BASKET_PULLED, JSON.stringify([...already, ...fresh.map((r) => r.id)]));
  } catch (e) {
    /* Not fatal: at worst a deleted receipt reappears once. */
  }
  return fresh.length;
}

/* ---- Light or dark, for the whole app ------------------------------------ */
/*
 * One key for both pages. Switching the theme in Basket and finding the
 * tracker still light is exactly the sort of seam that gives away two apps
 * bolted together. The old per-page keys are read once so nothing resets.
 */
const THEME_KEY = 'budget-theme';
/*
 * The LOOK is a second dimension, not a third theme: minted repaints the same
 * tokens and keeps its own light and dark, so the day/night switch goes on
 * meaning what it always meant.
 */
const LOOK_KEY = 'budget-look';

/** What the Android status bar is painted, which CSS cannot tell it. */
function chromeColour(mode, look) {
  if (look === 'minted') return mode === 'dark' ? '#07130D' : '#E4F2E6';
  return mode === 'dark' ? '#000000' : '#F2F2F7';
}

const lookNow = () => document.documentElement.dataset.look || 'default';

function applyLook(look) {
  const root = document.documentElement;
  if (look === 'minted') root.dataset.look = 'minted';
  else delete root.dataset.look;
  root.style.background = '';
  const label = $('#look-label');
  if (label) label.textContent = look === 'minted' ? 'Standard look' : 'Minted look';
  try {
    localStorage.setItem(LOOK_KEY, look);
  } catch (e) {
    /* private browsing */
  }
  try {
    if (window.Android && window.Android.setChrome) {
      const mode = root.dataset.theme;
      window.Android.setChrome(chromeColour(mode, look), mode === 'dark');
    }
  } catch (e) {
    /* older build without the bridge */
  }
}

function startLook() {
  let look = null;
  try {
    look = localStorage.getItem(LOOK_KEY);
  } catch (e) {
    look = null;
  }
  applyLook(look === 'minted' ? 'minted' : 'default');
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  // The inline script in <head> paints html before the stylesheet arrives, to
  // stop the flash. That inline style then OUTRANKS the stylesheet, so switching
  // the theme left the page colour behind - a strip of the old theme across the
  // top of the new one. Hand control back now that the stylesheet is here.
  document.documentElement.style.background = '';
  // The theme control is a row in the menu now, so the icon and the words go
  // into their own spans rather than replacing the button's whole contents.
  // Both say what tapping it GIVES you, not where you are.
  const icon = $('#theme-icon');
  const label = $('#theme-label');
  if (icon) icon.textContent = mode === 'dark' ? '☀' : '☾';
  if (label) label.textContent = mode === 'dark' ? 'Light appearance' : 'Dark appearance';
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch (e) {
    /* private browsing */
  }
  // The status and navigation bars are Android's, so they have to be told.
  try {
    if (window.Android && window.Android.setChrome) {
      window.Android.setChrome(chromeColour(mode, lookNow()), mode === 'dark');
    }
  } catch (e) {
    /* older build without the bridge */
  }
}

function startTheme() {
  let mode = null;
  try {
    mode =
      localStorage.getItem(THEME_KEY) ||
      localStorage.getItem('mpesa-theme') ||
      localStorage.getItem('basket-theme');
  } catch (e) {
    mode = null;
  }
  if (mode !== 'light' && mode !== 'dark') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(mode);
}

/* ---- Updating the app itself --------------------------------------------- */
/*
 * Only in the Android app, and only when asked: this is the one thing here that
 * touches the network. It lived on the Basket page alone, which stopped making
 * sense the moment the tracker became the page the app opens on.
 */
function wireUpdates() {
  let bridge = null;
  try {
    bridge = window.Android && window.Android.appVersion ? window.Android : null;
  } catch (e) {
    bridge = null;
  }
  $('#update-box').hidden = !bridge;
  if (!bridge) return;

  const msg = $('#update-msg');
  const install = $('#btn-install');
  try {
    const app = bridge.appVersion();
    msg.textContent =
      app === ASSET_BUILD
        ? `Version ${app}.`
        : `Version ${app}, but these pages are from ${ASSET_BUILD}. Close the app completely and open it again.`;
  } catch (e) {
    msg.textContent = '';
  }

  // A bridge call that throws must say so. Swallowing one is how the install
  // button spent a release looking like it did nothing.
  $('#btn-update').addEventListener('click', () => {
    msg.textContent = 'Checking…';
    try {
      bridge.checkUpdate();
    } catch (e) {
      msg.textContent = `Could not check: ${e.message}`;
    }
  });
  install.addEventListener('click', () => {
    try {
      bridge.installUpdate();
    } catch (e) {
      msg.textContent = `Could not start the download: ${e.message}`;
    }
  });

  window.onUpdateStatus = (text, canInstall) => {
    msg.textContent = String(text);
    install.hidden = !canInstall;
  };
}

/* ---- M-PESA's own messages, off the phone -------------------------------- */
/*
 * The app has always been able to read these - they are what the paste box is
 * for. On a phone there is no need to paste: the inbox is right there, and
 * Android will hand it over once. Categorising then happens exactly as it
 * does for a statement, by the rules, with anything unknown landing in
 * "Needs categorising" rather than being guessed at.
 */
function wireSms() {
  let bridge = null;
  try {
    bridge = window.Android && window.Android.canReadSms && window.Android.canReadSms() ? window.Android : null;
  } catch (e) {
    bridge = null;
  }
  $('#sms-col').hidden = !bridge;
  if (!bridge) return;

  const note = $('#sms-note');
  const ask = (everything) => {
    note.textContent = 'Asking Android for the messages…';
    try {
      bridge.readSms(everything);
    } catch (e) {
      note.textContent = 'This build cannot read messages.';
    }
  };
  $('#btn-sms').addEventListener('click', () => ask(false));
  $('#btn-sms-all').addEventListener('click', () => ask(true));

  window.onSmsStatus = (message) => {
    note.textContent = String(message);
  };

  // The inbox arrives in batches, so the tally is kept across them and the
  // page is only re-rendered once at the end.
  let tally = { added: 0, duplicate: 0, unparsed: [], ignored: 0 };
  window.onSmsBatch = (text, done, found, truncated, newestAt) => {
    if (text) {
      const { transactions, unparsed, ignored, settled, notices } = parseMessages(text);
      store.noteSettlements(settled);
      store.addLoanNotices(notices);
      const counts = store.addTransactions(transactions);
      tally.added += counts.added;
      tally.duplicate += counts.duplicate;
      tally.unparsed.push(...unparsed);
      tally.ignored += ignored;
    }
    if (!done) {
      note.textContent = `Reading ${found} messages… ${tally.added} new so far.`;
      return;
    }

    if (!found) {
      note.textContent = 'No new M-PESA messages in this phone\'s inbox.';
      tally = { added: 0, duplicate: 0, unparsed: [], ignored: 0 };
      return;
    }
    render();
    renderNameRules();
    const n = (v) => v.toLocaleString('en-GB');
    let msg = tally.added
      ? `${n(tally.added)} new transaction${tally.added === 1 ? '' : 's'} from ${n(found)} message${found === 1 ? '' : 's'}.`
      : `Read ${n(found)} message${found === 1 ? '' : 's'} \u2014 nothing new; it was all already on file.`;
    if (tally.added && tally.duplicate) msg += ` ${n(tally.duplicate)} were already on file.`;
    if (tally.unparsed.length) msg += ` ${n(tally.unparsed.length)} not recognised \u2014 see below.`;
    if (truncated) msg += ' This phone holds more than the app reads in one go; run it again for the rest.';
    // The age of the inbox itself. A read that brings in thousands of messages
    // and leaves the app looking empty is either a parser problem or an inbox
    // that stops before the window starts, and these are not the same problem.
    if (newestAt) {
      const when = new Date(Number(newestAt)).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
      msg += ` The newest M-PESA message on this phone is from ${when}.`;
    }
    note.textContent = msg;
    // Nothing new is the normal outcome of a re-read, not a warning.
    toast(msg, truncated ? 'warn' : 'ok');
    // Nothing is dropped silently, same as the paste box.
    showUnparsed(tally.unparsed, tally.ignored);
    tally = { added: 0, duplicate: 0, unparsed: [], ignored: 0 };
  };
}

/* ---- Shopping receipts from the phone app -------------------------------- */

function renderBasket() {
  const card = $('#basket-card');
  if (!card) return;
  const receipts = store.receipts();
  const links = store.receiptLinks();
  const paidCash = store.receiptCash();
  const txns = store.allTransactions();
  const byId = new Map(txns.map((t) => [t.id, t]));

  $('#basket-badge').textContent = receipts.length
    ? `${receipts.length} shop${receipts.length === 1 ? '' : 's'}`
    : '';

  const box = $('#basket');
  if (!receipts.length) {
    box.innerHTML =
      '<p class="hint">Nothing yet. In Basket Budget, open <em>Move your list</em> and tap <strong>Copy everything</strong>.</p>';
    renderBasketSearch();
    return;
  }

  const top = basket.itemTotals(receipts).slice(0, 8);
  box.innerHTML = `
    <h3 class="small">What your shopping actually goes on</h3>
    <table class="tight"><tbody>
      ${top
        .map(
          (t) => `<tr>
            <td>${escapeHtml(t.name)}<span class="dim small"> · ${t.qty} over ${t.times} shop${t.times === 1 ? '' : 's'}</span></td>
            <td class="num"><strong>${viz.fmt(t.total)}</strong></td>
          </tr>`,
        )
        .join('')}
    </tbody></table>
    <h3 class="small">Each shop</h3>
    ${receipts
      .map((r) => {
        const total = r.slipTotal != null ? r.slipTotal : basket.receiptTotal(r);
        const txn = byId.get(links[r.id]);
        const cash = paidCash[r.id];
        const where = txn
          ? `<span class="good">matched ${escapeHtml(String(txn.counterparty || '—'))}</span>`
          : cash
            ? '<span class="good">paid in cash</span>'
            : '<span class="dim">no payment matched</span>';
        return `<details class="sub">
          <summary>
            <strong>${shortDate(r.date + 'T12:00:00Z')}</strong>
            · ${r.items.length} item${r.items.length === 1 ? '' : 's'}
            · <strong>${viz.fmt(total)}</strong> · ${where}
          </summary>
          <table class="tight"><tbody>
            ${r.items
              .map(
                (i) => `<tr>
                  <td>${escapeHtml(i.name)}${i.qty > 1 ? `<span class="dim small"> · ${i.qty} @ ${viz.fmt(i.price)}</span>` : ''}</td>
                  <td class="num">${viz.fmt(i.price * i.qty)}</td>
                </tr>`,
              )
              .join('')}
          </tbody></table>
          <div class="row">
            ${
              txn
                ? ''
                : cash
                  ? `<button type="button" class="link" data-receipt-uncash="${escapeHtml(r.id)}">Not cash after all</button>`
                  : `<button type="button" class="link" data-receipt-cash="${escapeHtml(r.id)}">I paid this in cash</button>`
            }
            <button type="button" class="link" data-drop-receipt="${escapeHtml(r.id)}">Remove this receipt</button>
          </div>
        </details>`;
      })
      .join('')}`;

  box.querySelectorAll('[data-receipt-cash]').forEach((b) =>
    b.addEventListener('click', () => {
      const run = store.payReceiptInCash(b.dataset.receiptCash);
      if (!run) return;
      render();
      renderBasket();
      // Said plainly, because the total deliberately does NOT move: the money
      // was counted when it was drawn out, and this only says what it bought.
      toast(`${viz.fmt(run.amount)} booked against your cash. Your spending total is unchanged.`);
    }),
  );
  box.querySelectorAll('[data-receipt-uncash]').forEach((b) =>
    b.addEventListener('click', () => {
      store.unpayReceiptInCash(b.dataset.receiptUncash);
      render();
      renderBasket();
    }),
  );
  box.querySelectorAll('[data-drop-receipt]').forEach((b) =>
    b.addEventListener('click', () => {
      // The cash run it created goes with it, or the money would be claimed by
      // a receipt that no longer exists.
      store.unpayReceiptInCash(b.dataset.dropReceipt);
      store.removeReceipt(b.dataset.dropReceipt);
      render();
      renderBasket();
    }),
  );
  renderBasketSearch();
}

function renderBasketSearch() {
  const out = $('#basket-search-out');
  if (!out) return;
  const hits = basket.findItems(store.receipts(), $('#basket-search').value);
  if (!$('#basket-search').value.trim()) {
    out.innerHTML = '';
    return;
  }
  if (!hits.length) {
    out.innerHTML = '<p class="hint">Nothing by that name in your receipts.</p>';
    return;
  }
  const total = hits.reduce((s, h) => s + h.item.price * h.item.qty, 0);
  out.innerHTML = `
    <p class="hint"><strong>${viz.fmt(total)}</strong> across ${hits.length} line${hits.length === 1 ? '' : 's'}.</p>
    <table class="tight"><tbody>
      ${hits
        .map(
          (h) => `<tr>
            <td>${escapeHtml(h.item.name)}<span class="dim small"> · ${shortDate(h.date + 'T12:00:00Z')} · ${h.item.qty} @ ${viz.fmt(h.item.price)}</span></td>
            <td class="num">${viz.fmt(h.item.price * h.item.qty)}</td>
          </tr>`,
        )
        .join('')}
    </tbody></table>`;
}

function wireBasket() {
  const paste = $('#basket-paste');
  if (!paste) return;
  $('#basket-import').addEventListener('click', () => {
    const note = $('#basket-note');
    let parsed;
    try {
      parsed = basket.parseBasket(paste.value);
    } catch (e) {
      note.textContent = e.message;
      return;
    }
    if (!parsed.receipts.length) {
      note.textContent =
        'That list has no receipts in it. Use "Copy everything", not "Copy my list".';
      return;
    }
    const counts = store.importReceipts(parsed.receipts);
    // Match against the statement now, so a shop lands on the payment that
    // settled it rather than floating loose.
    const links = basket.matchAll(store.receipts(), store.allTransactions());
    store.setReceiptLinks(links);
    const matched = Object.keys(links).length;
    note.textContent =
      `${counts.added} new, ${counts.replaced} updated. ` +
      `${matched} of ${counts.total} matched to a payment.`;
    paste.value = '';
    renderBasket();
  });
  $('#basket-search').addEventListener('input', renderBasketSearch);
}

init();
