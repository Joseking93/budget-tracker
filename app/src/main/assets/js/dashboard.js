// Aggregation + chart rendering. Charts are hand-rolled SVG — no chart library, so
// the app stays dependency-free and works offline.

import { CLASSES, classOf, categoryParts } from './rules.js';

const KES = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
const fmt = (n) => KES.format(Math.round(n));

// Single-hue ramp, ordered by spend. This is an *ordinal* ramp (discrete ranked
// categories), not a continuous sequential one, so every step must stay visible
// against the surface — the step nearest the surface still clears 2:1.
//
// The hue is the app's own: amber on black, indigo on white. It was blue, from
// when this page had a palette of its own, and a column of blue bars was the
// last thing still announcing that the tracker and Basket used to be two
// different apps. Safe to re-hue because an ordinal ramp carries its meaning in
// LIGHTNESS, which is ordered here and reads the same to everyone; the one thing
// that must never be re-picked by eye is a categorical set, and there isn't one.
const RAMP_LIGHT = ['#b0a8e8', '#9f96e0', '#8e84d8', '#7d71d0', '#6c5fc6', '#5c4fba', '#4f42a9', '#443896', '#3a2f82', '#2f266b'];
const RAMP_DARK = ['#8a5a00', '#a06800', '#b77700', '#cf8700', '#e69600', '#ff9f0a', '#ffb13a', '#ffc264', '#ffd28d', '#ffe3b8'];

const isDark = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

const ramp = () => (isDark() ? RAMP_DARK : RAMP_LIGHT);

// Rank → color. Biggest spender darkest (light mode) so weight reads as ink.
export function rampAt(rank, total) {
  const r = ramp();
  if (total <= 1) return r[Math.floor(r.length / 2)];
  const t = rank / (total - 1);
  return r[Math.round((1 - t) * (r.length - 1))];
}

export function summarise(txns) {
  let spending = 0;
  let fees = 0;
  let income = 0;
  let transfers = 0;

  for (const t of txns.flatMap(categoryParts)) {
    const cls = classOf(t.category);
    // A refund linked to a spend reduces that spend. It is not income — it's money
    // you'd already parted with coming back — and counting it as earnings would
    // overstate both sides of the ledger at once.
    if (t.isOffset) {
      if (cls === CLASSES.FEE) fees -= t.amount;
      else spending -= t.amount;
      continue;
    }
    // Class is checked before direction, deliberately. A loan disbursement or an
    // overdraft credit arrives as money IN, but borrowing is not earning; letting
    // direction decide would book every Fuliza advance as income.
    if (cls === CLASSES.FEE) fees += t.amount;
    else if (cls === CLASSES.TRANSFER) transfers += t.amount;
    else if (cls === CLASSES.INCOME || t.direction === 'In') income += t.amount;
    else spending += t.amount;
  }
  return { spending, fees, income, transfers, realSpend: spending + fees, net: income - (spending + fees) };
}

export function byCategory(txns, cls) {
  const m = new Map();
  for (const t of txns.flatMap(categoryParts)) {
    // Inbound money is skipped — except a refund linked to a spend, which subtracts
    // from the category it paid back.
    if (t.direction === 'In' && !t.isOffset) continue;
    const c = classOf(t.category);
    if (cls && c !== cls) continue;
    if (!cls && (c === CLASSES.INCOME || c === CLASSES.TRANSFER)) continue;
    const cur = m.get(t.category) || { category: t.category, total: 0, count: 0 };
    if (t.isOffset) {
      cur.total -= t.amount; // it isn't another purchase, so the count doesn't move
    } else {
      cur.total += t.amount;
      cur.count++;
    }
    m.set(t.category, cur);
  }
  return [...m.values()].filter((r) => r.count > 0).sort((a, b) => b.total - a.total);
}

export function byMerchant(txns, limit = 12) {
  const m = new Map();
  for (const t of txns) {
    if (t.direction === 'In') continue;
    const key = t.counterparty || '(unknown)';
    const cur = m.get(key) || { name: key, total: 0, count: 0, category: t.category };
    cur.total += t.amount;
    cur.count++;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

// Group by day for short ranges, by month once the history is long enough that
// daily bars would be unreadable.
export function overTime(txns) {
  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  if (!dates.length) return { buckets: [], grain: 'day' };
  const span = (new Date(dates.at(-1)) - new Date(dates[0])) / 86400000;
  const grain = span > 62 ? 'month' : 'day';

  const m = new Map();
  for (const t of txns.flatMap(categoryParts)) {
    if (!t.date || t.direction === 'In') continue;
    const cls = classOf(t.category);
    if (cls === CLASSES.TRANSFER || cls === CLASSES.INCOME) continue;
    const key = grain === 'month' ? t.date.slice(0, 7) : t.date.slice(0, 10);
    m.set(key, (m.get(key) || 0) + t.amount);
  }
  const buckets = [...m.entries()].map(([key, total]) => ({ key, total })).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { buckets, grain };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Horizontal bars — long category names need the room. */
export function renderCategoryBars(el, rows, slotOf = null) {
  if (!rows.length) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.total));
  el.innerHTML = rows
    .map((r, i) => {
      const pct = (r.total / max) * 100;
      return `<div class="bar-row drill" tabindex="0" role="listitem" data-drill-cat="${esc(r.category)}"
                   title="Show these transactions"
                   aria-label="${esc(r.category)}: ${fmt(r.total)} shillings across ${r.count} transactions. Activate to see them.">
          <div class="bar-label">${esc(r.category)}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${
              slotOf ? seriesColour(slotOf(r.category)) : rampAt(i, rows.length)
            }"></div>
          </div>
          <div class="bar-value">${fmt(r.total)}<span class="bar-count">${r.count}×</span></div>
        </div>`;
    })
    .join('');
}

/** Single-series columns over time, with a hover tooltip. */
export function renderTrend(el, buckets, grain) {
  if (buckets.length < 1) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }
  const W = 720;
  const H = 200;
  const PAD = { t: 12, r: 12, b: 28, l: 52 };
  const max = Math.max(...buckets.map((b) => b.total)) || 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = Math.min(48, (iw / buckets.length) * 0.68);
  const step = iw / buckets.length;
  const hue = isDark() ? '#ff9f0a' : '#4b3fbf';

  const ticks = [0, max / 2, max].map((v) => {
    const y = PAD.t + ih - (v / max) * ih;
    return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/>
            <text class="tick" x="${PAD.l - 8}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`;
  });

  const bars = buckets.map((b, i) => {
    const h = Math.max(2, (b.total / max) * ih);
    const x = PAD.l + i * step + (step - bw) / 2;
    const y = PAD.t + ih - h;
    const label = grain === 'month' ? monthLabel(b.key) : b.key.slice(8) + '/' + b.key.slice(5, 7);
    return `<g class="col" tabindex="0" role="listitem" aria-label="${esc(label)}: ${fmt(b.total)} shillings">
        <title>${esc(label)} — KES ${fmt(b.total)}</title>
        <rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${hue}"/>
        <text class="tick" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>
      </g>`;
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="list" aria-label="Spending over time">
      ${ticks.join('')}
      <line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${PAD.t + ih}" y2="${PAD.t + ih}"/>
      ${bars.join('')}
    </svg>`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en', { month: 'short' }) + ' ' + y.slice(2);
}

/** The bank<->M-PESA pairing report. Only meaningful once both accounts are loaded. */
export function renderReconcile(el, r) {
  const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', yy: '2-digit' });

  if (!r.checked) {
    el.innerHTML = `<p class="empty">The two statements don't overlap in time, so there is nothing to cross-check.
      Import a bank statement and an M-PESA statement covering the same period.</p>`;
    return;
  }

  const value = r.matched.reduce((a, x) => a + x.bank.amount, 0);
  const total = r.matched.length + r.unmatchedBank.length;
  const allMatched = r.unmatchedBank.length === 0;

  el.innerHTML = `
    <div class="recon-head">
      <div class="recon-stat">
        <span class="kpi-label">Matched pairs</span>
        <span class="kpi-value">${r.matched.length}<span class="dim" style="font-size:14px">/${total}</span></span>
        <span class="kpi-note">${fmt(value)} counted once</span>
      </div>
      <div class="recon-stat">
        <span class="kpi-label">Checked period</span>
        <span class="kpi-value" style="font-size:15px">${day(r.window.from)} – ${day(r.window.to)}</span>
        <span class="kpi-note">where both statements overlap</span>
      </div>
      <div class="recon-stat">
        <span class="kpi-label">Outside that period</span>
        <span class="kpi-value">${r.outsideWindow}</span>
        <span class="kpi-note">no counterpart to check against</span>
      </div>
    </div>
    ${
      allMatched
        ? `<p class="recon-ok">✓ Every bank↔M-PESA movement in the overlapping period was matched to its other half.</p>`
        : `<p class="recon-warn"><strong>${r.unmatchedBank.length} bank movement(s) had no M-PESA counterpart.</strong>
             A transfer between two of your own bank accounts belongs here — it has no M-PESA side. Anything else is worth a look:</p>
           <ul class="recon-list">${r.unmatchedBank
             .map((x) => `<li>${x.date.slice(0, 10)} · ${fmt(x.amount)} · ${esc(x.counterparty)}</li>`)
             .join('')}</ul>`
    }
    <details class="recon-details">
      <summary>Show the ${r.matched.length} matched pairs</summary>
      <table class="mini">
        <thead><tr><th>Date</th><th class="num">Amount</th><th>Bank side</th><th>M-PESA side</th><th class="num">Gap</th></tr></thead>
        <tbody>${r.matched
          .map(
            (x) => `<tr>
            <td class="dim nowrap">${x.bank.date.slice(0, 10)}</td>
            <td class="num">${fmt(x.bank.amount)}</td>
            <td>${esc(x.bank.counterparty)}</td>
            <td class="dim">${esc(String(x.mpesa.counterparty).slice(0, 46))}</td>
            <td class="num dim">${x.gapHours}h</td>
          </tr>`
          )
          .join('')}</tbody>
      </table>
    </details>`;
}

/** Balance line over time, with a hover crosshair. */
export function renderBalance(el, series, label) {
  if (series.length < 2) {
    el.innerHTML = '<p class="empty">Not enough balance history to chart.</p>';
    return;
  }
  const W = 720;
  const H = 190;
  const PAD = { t: 12, r: 14, b: 26, l: 58 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const vals = series.map((p) => p.balance);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const x = (i) => PAD.l + (i / (series.length - 1)) * iw;
  const y = (v) => PAD.t + ih - ((v - min) / (max - min || 1)) * ih;
  const hue = isDark() ? '#ff9f0a' : '#4b3fbf';

  const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${d} L${x(series.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;

  const ticks = [min, (min + max) / 2, max].map((v) => {
    const yy = y(v);
    return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${yy}" y2="${yy}"/>
            <text class="tick" x="${PAD.l - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
  });

  // Month boundaries give the eye something to hang the timeline on.
  const marks = [];
  let lastMonth = null;
  series.forEach((p, i) => {
    const m = p.day.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      if (i > 0)
        marks.push(
          `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${new Date(p.day + 'T00:00Z').toLocaleDateString('en-GB', { month: 'short' })}</text>`
        );
    }
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} balance over time">
      ${ticks.join('')}
      <path d="${area}" fill="${hue}" opacity="0.10"/>
      <path d="${d}" fill="none" stroke="${hue}" stroke-width="2" stroke-linejoin="round"/>
      ${marks.join('')}
      <g class="bal-hover"></g>
    </svg>
    <div class="bal-read"><span class="dim">Hover the line for a day</span></div>`;

  const svg = el.querySelector('svg');
  const read = el.querySelector('.bal-read');
  const hover = el.querySelector('.bal-hover');
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.l) / iw) * (series.length - 1));
    const p = series[Math.max(0, Math.min(series.length - 1, i))];
    if (!p) return;
    hover.innerHTML = `<line class="grid" x1="${x(series.indexOf(p))}" x2="${x(series.indexOf(p))}" y1="${PAD.t}" y2="${PAD.t + ih}" stroke="${hue}"/>
      <circle cx="${x(series.indexOf(p))}" cy="${y(p.balance)}" r="4" fill="${hue}" stroke="var(--surface-1)" stroke-width="2"/>`;
    read.innerHTML = `<strong>${fmt(p.balance)}</strong> <span class="dim">on ${new Date(p.day + 'T00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>`;
  });
  svg.addEventListener('mouseleave', () => {
    hover.innerHTML = '';
    read.innerHTML = '<span class="dim">Hover the line for a day</span>';
  });
}

export function renderMerchants(el, rows) {
  if (!rows.length) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }
  el.innerHTML = `<table class="mini">
      <thead><tr><th>Merchant</th><th>Category</th><th class="num">Total</th><th class="num">Txns</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr class="drill" data-drill-name="${esc(r.name)}" tabindex="0" title="Show these transactions">
                 <td>${esc(r.name)}</td><td class="dim">${esc(r.category)}</td>
                 <td class="num">${fmt(r.total)}</td><td class="num dim">${r.count}</td></tr>`
        )
        .join('')}</tbody></table>`;
}

/* ---- The transaction list ---------------------------------------------- */
//
// Rows grouped by day, the way every bank app on the phone already reads:
// the date is said once, with what went out that day beside it, and each row
// is what / where it went / how much. The category is a chip, not a dropdown
// on every line - changing it is a tap into the row, which opens the sheet
// (app.js, openTxnSheet), so the list scans instead of being thirty controls.

const SORTS = [
  { key: 'date', label: 'Date' },
  { key: 'amount', label: 'Amount' },
  { key: 'counterparty', label: 'Name' },
  { key: 'category', label: 'Category' },
];

const SORT_ARROW = (dir) =>
  `<svg class="tx-sort-dir" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${
          dir === 'asc' ? 'M2 6.5 5 3.5 8 6.5' : 'M2 3.5 5 6.5 8 3.5'
        }"/></svg>`;

const NOTE_ICON =
  `<svg class="tx-note-i" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5z M8.5 9.5h7 M8.5 12.5h4.5"/></svg>`;

/** The calendar day a transaction fell on, on this phone's clock - the dates are stored in UTC. */
export function dayOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "12:40", or nothing when the statement only gave a date. */
export function timeOf(iso) {
  // A statement row carries only a date, stored as midnight.
  if (!iso || String(iso).length < 16 || /T00:00(:00(\.0+)?)?Z?$/.test(iso)) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.getHours() === 0 && d.getMinutes() === 0) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * @param {HTMLElement} el
 * @param {object[]} txns  decorated, sorted, already cut to the page limit
 * @param {object} o
 * @param {{key: string, dir: string}} o.sort
 * @param {(key: string) => void} o.onSort
 * @param {number|null} o.totalBeforeFilters  0 means there is no data at all
 * @param {{shown: number, total: number, onMore: Function}|null} o.more
 * @param {(id: string) => void} o.onOpen  a row was tapped
 * @param {(category: string) => string} o.discOf  the category's disc, as HTML
 * @param {(category: string) => string} o.hueOf  the category's colour
 * @param {(day: string) => string} o.dateLabel  how a day is named in its header
 * @param {(iso: string) => string} o.shortDate  the date on a row when not grouped by day
 */
export function renderTable(el, txns, o) {
  const { sort, onSort, totalBeforeFilters = null, more = null, onOpen, discOf, hueOf, dateLabel, shortDate } = o;
  if (!txns.length) {
    // An empty app and an over-narrow filter are different problems; telling someone
    // with no data to "clear the filters" sends them looking for a filter that isn't set.
    el.innerHTML =
      totalBeforeFilters === 0
        ? `<p class="empty">Nothing here yet. Import a statement PDF or paste M-PESA messages above.</p>`
        : `<p class="empty">No transactions match these filters.</p>`;
    return;
  }

  const sorter = `<div class="tx-sort" role="group" aria-label="Sort by">
      <span class="tx-sort-lab">Sort</span>${SORTS.map((s) => {
        const on = sort.key === s.key;
        return `<button type="button" class="tx-sort-b${on ? ' on' : ''}" data-sort="${s.key}"
                  aria-pressed="${on}">${s.label}${on ? SORT_ARROW(sort.dir) : ''}</button>`;
      }).join('')}</div>`;

  const row = (t, withDate) => {
    const out = t.direction !== 'In';
    const cat = t.category || 'Uncategorised';
    const extra = t.isSplit && t.splits ? t.splits.length - 1 : 0;
    const when = [withDate ? shortDate(t.date) : '', timeOf(t.date)].filter(Boolean).join(' · ');
    return `<button type="button" class="tx" data-open="${esc(t.id)}">
        ${discOf(cat)}
        <span class="tx-text">
          <span class="tx-name">${esc(t.counterparty || '—')}</span>
          <span class="tx-meta">
            <span class="tx-chip" style="--hue:${hueOf(cat)}">${esc(cat)}${extra ? ` +${extra}` : ''}</span>
            ${when ? `<span class="tx-when">${esc(when)}</span>` : ''}
            ${t.note ? `<span class="tx-note" title="${esc(t.note)}">${NOTE_ICON}<span>${esc(t.note)}</span></span>` : ''}
          </span>
        </span>
        <span class="tx-amt ${out ? 'out' : 'in'}">${out ? '−' : '+'}${fmt(t.amount)}</span>
      </button>`;
  };

  // By day only when the list is in date order. Sorted by amount, a day header
  // would be repeated above every other row; one block with the date on each
  // row reads better.
  let body;
  if (sort.key === 'date') {
    const days = [];
    for (const t of txns) {
      const k = dayOf(t.date);
      if (!days.length || days[days.length - 1].k !== k) days.push({ k, rows: [] });
      days[days.length - 1].rows.push(t);
    }
    body = days
      .map(({ k, rows }) => {
        const outs = rows.filter((t) => t.direction !== 'In').reduce((a, t) => a + t.amount, 0);
        const ins = rows.filter((t) => t.direction === 'In').reduce((a, t) => a + t.amount, 0);
        const sum = [outs ? `−${fmt(outs)}` : '', ins ? `+${fmt(ins)}` : ''].filter(Boolean).join(' · ');
        return `<div class="tx-day"><span>${esc(dateLabel(k))}</span><span>${sum}</span></div>
          <section class="tx-group">${rows.map((t) => row(t, false)).join('')}</section>`;
      })
      .join('');
  } else {
    body = `<section class="tx-group">${txns.map((t) => row(t, true)).join('')}</section>`;
  }

  el.innerHTML = sorter + body;

  el.querySelectorAll('button[data-open]').forEach((b) =>
    b.addEventListener('click', () => onOpen(b.dataset.open))
  );
  // Same key flips the direction; a new key starts descending (app.js).
  el.querySelectorAll('button[data-sort]').forEach((b) =>
    b.addEventListener('click', () => onSort(b.dataset.sort))
  );

  // Showing every transaction at once is thousands of rows nobody scrolls to, and
  // the cost is paid again on every re-render. The filters above are the way to
  // find something; this is the way to keep reading.
  if (more && more.shown < more.total) {
    const btn = document.createElement('button');
    btn.className = 'ghost more-rows';
    btn.type = 'button';
    btn.textContent = `Show more — ${more.shown} of ${more.total}`;
    btn.addEventListener('click', more.onMore);
    el.appendChild(btn);
  }
}

/** Sort a decorated transaction list. Amounts sort numerically, everything else by text. */
export function sortTxns(txns, { key, dir }) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...txns].sort((a, b) => {
    let x = a[key];
    let y = b[key];
    if (key === 'amount') return (x - y) * mul;
    x = String(x ?? '').toLowerCase();
    y = String(y ?? '').toLowerCase();
    if (x === y) return 0;
    return (x < y ? -1 : 1) * mul;
  });
}

export { fmt };

/* ---- The ring ------------------------------------------------------------ */
//
// Where the money went, as a shape. The ranked bars underneath answer "how much
// on what" precisely; the ring answers "what is this month SHAPED like" at a
// glance - one category eating half of it reads instantly, which is the one
// thing a sorted list of numbers cannot show you.
//
// Eight colours, assigned per CATEGORY rather than per rank, so Groceries is the
// same colour next month even when it moves from second to fourth. A ninth
// category is never given a new hue: the tail folds into "Other", which is also
// the only honest thing to do with twenty slices too thin to see.

/** Validated categorical hues, in fixed order. See the data-viz palette. */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export const seriesColour = (slot) => (isDark() ? SERIES_DARK : SERIES_LIGHT)[slot % 8];

/** How many slices before the tail is folded away. */
export const DONUT_SLICES = 7;

/**
 * What the folded tail is called.
 *
 * Deliberately not "Other": that is a real category, and naming the fold after
 * one means a tap on it filters to that category instead of to the things it
 * actually folded up.
 */
export const REST_LABEL = 'Everything else';

/**
 * Rank the categories and fold the tail.
 *
 * @param {object[]} rows  byCategory output, biggest first
 * @returns {{category: string, total: number, count: number, rest?: string[]}[]}
 */
export function donutRows(rows) {
  if (rows.length <= DONUT_SLICES + 1) return rows;
  const head = rows.slice(0, DONUT_SLICES);
  const tail = rows.slice(DONUT_SLICES);
  return [
    ...head,
    {
      category: REST_LABEL,
      total: tail.reduce((a, r) => a + r.total, 0),
      count: tail.reduce((a, r) => a + r.count, 0),
      rest: tail.map((r) => r.category),
    },
  ];
}

/**
 * @param {Function} slotOf  category -> 0..7, stable across renders
 */
/** The folded row filters to everything it folded; a real one to itself. */
const drillAttr = (r) =>
  r.rest
    ? `data-drill-cats="${esc(r.rest.join('|'))}" data-drill-label="${esc(REST_LABEL)}"`
    : `data-drill-cat="${esc(r.category)}"`;

/**
 * @param {object}  o
 * @param {boolean} o.middle  false leaves the hole empty - the hero card puts
 *                            its own figure there, and two totals in one ring
 *                            is one too many.
 * @param {boolean} o.legend  false draws the ring alone.
 * @param {boolean} o.ring    false draws the legend alone - for a page that
 *                            is already carrying this ring further up.
 * @param {boolean}  o.hero    the Minted hero treatment: a heavier ring whose
 *                             slices meet at a hairline. Rounded ends were
 *                             tried and dropped - a cap hangs half a stroke
 *                             past each end, so no slice could be drawn
 *                             thinner than the stroke and the small
 *                             categories had to be folded away to hide it.
 *                             Square ends cost nothing and give them back.
 * @param {Function} o.iconOf  category -> the one character to sit on a disc
 *                             on its slice.
 * @param {boolean}  o.grow    draw the ring once round from twelve o'clock
 *                             instead of appearing whole. Only on the first
 *                             drawing of a session: an animation that runs
 *                             again every time a figure changes stops being
 *                             an entrance and becomes a flicker.
 */
export function renderDonut(
  el,
  rows,
  slotOf,
  {
    label = 'spent', middle = true, legend = true, ring = true, hero = false,
    iconOf = null, grow = false,
  } = {},
) {
  if (!rows.length || rows.reduce((a, r) => a + r.total, 0) <= 0) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }

  const R = 52;
  const W = hero ? 13 : 16;
  // Big enough for a glyph to be legible once the ring is drawn at phone size,
  // small enough that eight of them fit round the circle.
  const PIN_R = 9.5;
  const C = 2 * Math.PI * R;
  // A 2px gap in the surface colour is what separates touching slices - never a
  // stroke around them, which would add ink that is not data. In this viewBox
  // 1.6 units lands at about 2px once the ring is drawn at its real size.
  // 1.6 units is about 2px on the ring as the standard look draws it; the hero
  // ring is drawn half as big again on a laptop and three times that on a
  // phone, so it needs a smaller figure to land on the same hairline.
  const GAP = rows.length > 1 ? (hero ? 0.9 : 1.6) : 0;
  const total = rows.reduce((a, r) => a + r.total, 0);

  let at = 0;
  const arcs = rows
    .map((r, i) => {
      const len = Math.max((r.total / total) * C - GAP, 0.6);
      const dash = `${len} ${C - len}`;
      const offset = -at;
      at += (r.total / total) * C;
      // Growing one: it starts as nothing and is told its real length a frame
      // later, so the browser's own transition walks it round. The delay is
      // what makes the slices arrive one after another rather than together.
      return `<circle class="ring-arc${grow ? ' grow' : ''}" cx="60" cy="60" r="${R}"
                 fill="none" stroke="${seriesColour(slotOf(r.category))}" stroke-width="${W}"
                 stroke-dasharray="${grow ? `0 ${C}` : dash}" stroke-dashoffset="${offset}"
                 ${grow ? `data-dash="${dash}" style="transition-delay:${(i * 70).toFixed(0)}ms"` : ''}
                 ${drillAttr(r)}><title>${esc(r.category)}: ${fmt(r.total)}</title></circle>`;
    })
    .join('');

  // A disc on EVERY slice, at the middle of its own arc - and where two of
  // them would land on top of each other, pushed apart along the ring until
  // they do not.
  //
  // A disc is 19 units across on a ring 327 units round, so it takes 5.8% of
  // the circle whatever its slice is worth. Before the spreading, the only way
  // to stop two discs colliding was to draw none under 9%, and a month with
  // one big category then left most of the ring unlabelled. Eight slices at
  // 6.4% apiece still fill only half the circle, so there is always somewhere
  // to spread into. A disc that has moved off its own arc carries its own
  // filter, so the tap still opens the category the icon is for.
  let pins = '';
  if (iconOf && rows.length) {
    const SEP = (2 * PIN_R + 1.6) / C;
    // A slice carries an icon when the slice is at least as wide as the icon.
    // Below that it is a sliver: the disc would be wider than the colour it
    // is standing on, and a row of them crowds the one part of the ring that
    // has the least to say. The small categories are still in the list under
    // the ring, which is where their names are anyway.
    const FITS = (2 * PIN_R) / C;
    let seen = 0;
    const show = [];
    for (const r of rows) {
      const share = r.total / total;
      if (share >= FITS) show.push({ row: r, mid: seen + share / 2 });
      seen += share;
    }
    const n = show.length;
    const at = show.map((p) => p.mid);
    // Relaxation: the slices are already in order round the circle, so a pass
    // only has to push each neighbouring pair apart - including the last pair,
    // which meets round the back at twelve o'clock.
    if (n > 1) {
      for (let pass = 0; pass < 80; pass += 1) {
        let worst = 0;
        for (let i = 0; i < n; i += 1) {
          const j = (i + 1) % n;
          const gap = at[j] - at[i] + (j === 0 ? 1 : 0);
          const push = (SEP - gap) / 2;
          if (push > 0) {
            at[i] -= push;
            at[j] += push;
            if (push > worst) worst = push;
          }
        }
        if (worst < 1e-5) break;
      }
    }
    show.forEach(({ row: r }, i) => {
      const a = (at[i] * 2 - 0.5) * Math.PI;
      const x = 60 + Math.cos(a) * R;
      const y = 60 + Math.sin(a) * R;
      pins += `<g class="ring-pin${grow ? ' ring-late' : ''}" ${drillAttr(r)}>
          <title>${esc(r.category)}: ${fmt(r.total)}</title>
          <circle class="ring-pin-disc" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${PIN_R}"/>
          <text class="ring-pin-ico" x="${x.toFixed(1)}" y="${(y + 3.6).toFixed(1)}"
                text-anchor="middle">${esc(iconOf(r.category))}</text>
        </g>`;
    });
  }

  const legendHtml = !legend ? '' : rows
    .map((r) => {
      const pct = Math.round((r.total / total) * 100);
      // The name is always written out: three of the light-mode hues sit under
      // 3:1 on white, so identity can never rest on the colour alone.
      return `<button type="button" class="leg" ${drillAttr(r)}
                 title="${r.rest ? esc(r.rest.join(', ')) : 'Show these transactions'}">
          <span class="leg-dot" style="background:${seriesColour(slotOf(r.category))}"></span>
          <span class="leg-text">
            <span class="leg-name">${esc(r.category)}</span>
            <span class="leg-sub">${pct}% · ${r.count}&times;</span>
          </span>
          <span class="leg-amt">${fmt(r.total)}</span>
        </button>`;
    })
    .join('');

  el.innerHTML = `
    ${!ring ? '' : `<div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" role="img" aria-label="Spending by category">
        <g transform="rotate(-90 60 60)">${arcs}</g>${pins}
      </svg>
      ${middle ? `<div class="ring-mid">
        <span class="ring-total">${fmt(total)}</span>
        <span class="ring-label">${esc(label)}</span>
      </div>` : ''}
    </div>`}
    ${legend ? `<div class="legend">${legendHtml}</div>` : ''}`;

  if (grow) {
    // Driven here rather than by a CSS transition on stroke-dasharray. That
    // transition is the obvious way to write this and it is not dependable:
    // whether it runs at all depends on the engine having computed a starting
    // value first, which a view that has only just been handed its markup may
    // never have done. A dash length worked out frame by frame always does
    // the same thing, and can be watched doing it.
    const arcs = [...el.querySelectorAll('.ring-arc.grow')];
    const late = [...el.querySelectorAll('.ring-late')];
    const DUR = 900;
    const STAGGER = 70;   // between one slice starting and the next
    const FADE_AT = 520;  // the names arrive once the ring is most of the way
    const finish = () => {
      arcs.forEach((arc) => { arc.style.strokeDasharray = arc.dataset.dash; });
      late.forEach((g) => { g.style.opacity = '1'; });
    };
    const still = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) {
      finish();
    } else {
      const began = performance.now();
      let frames = 0;
      const tick = (now) => {
        frames += 1;
        const since = now - began;
        let running = false;
        arcs.forEach((arc, i) => {
          const p = Math.max(0, Math.min(1, (since - i * STAGGER) / DUR));
          if (p < 1) running = true;
          const eased = 1 - (1 - p) ** 3;
          const [len, gap] = arc.dataset.dash.split(' ').map(Number);
          // The gap takes back whatever the dash has not grown into, so the
          // pattern stays the length of the circle and the slice stays put.
          arc.style.strokeDasharray = `${len * eased} ${gap + len * (1 - eased)}`;
        });
        const fade = Math.max(0, Math.min(1, (since - FADE_AT) / 420));
        late.forEach((g) => { g.style.opacity = String(fade); });
        if (running || fade < 1) requestAnimationFrame(tick);
        else finish();
      };
      requestAnimationFrame(tick);
      // A view that is not painting yet never calls back, and an empty ring is
      // worse than one that simply appeared.
      setTimeout(() => { if (!frames) finish(); }, 300);
    }
  }
}
