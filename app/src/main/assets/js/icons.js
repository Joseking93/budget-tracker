/**
 * The category glyphs.
 *
 * These used to be emoji, which the PHONE draws, not the app: a full-colour
 * fuel pump with a nozzle, a hose and a highlight, rendered into a 19px disc,
 * came out as a smudge - and two different lines that both matched "fuel"
 * came out as the same smudge twice. A glyph is one stroke weight at every
 * size and takes the colour it is given, so it can be the category's own.
 *
 * Each entry is a 24x24 path string, several subpaths separated by " M".
 * No font to bundle: the paths are the data.
 */
const G = {
  house: 'M3.2 10.4 12 3.5l8.8 6.9 M5.6 9.2V20.3h12.8V9.2 M9.8 20.3v-5.1h4.4v5.1',
  basket:
    'M3.3 8.4h17.4l-1.7 10.4a2 2 0 0 1-2 1.7H7a2 2 0 0 1-2-1.7Z M8.3 8.4 11 3.4 M15.7 8.4 13 3.4'
    + ' M9.4 12v4.6 M14.6 12v4.6',
  fuel:
    'M4.3 20.4V5.8a2 2 0 0 1 2-2h4.6a2 2 0 0 1 2 2v14.6 M3 20.4h11.2 M6.6 8.4h4'
    + ' M15.4 7.2l2.9 2.9v6.8a1.5 1.5 0 0 1-3 0v-4.3h2.9',
  car:
    'M5.2 16.6 6.9 10.4a2 2 0 0 1 1.9-1.4h6.4a2 2 0 0 1 1.9 1.4l1.7 6.2 M4.2 16.6h15.6v2.6H4.2z'
    + ' M7.2 19.2v1.4 M16.8 19.2v1.4 M7.6 13h8.8',
  bolt: 'M13.4 2.8 5 13.6h5.6L9.8 21.2 19 10.4h-5.6z',
  drop: 'M12 3.4c3.4 3.6 5.6 6.4 5.6 9.2a5.6 5.6 0 0 1-11.2 0c0-2.8 2.2-5.6 5.6-9.2z',
  wifi:
    'M2.8 9.2a14.5 14.5 0 0 1 18.4 0 M5.8 12.8a10 10 0 0 1 12.4 0 M8.9 16.3a5.4 5.4 0 0 1 6.2 0'
    + ' M12 19.8h.01',
  phone:
    'M7.4 2.9h9.2a1.6 1.6 0 0 1 1.6 1.6v15a1.6 1.6 0 0 1-1.6 1.6H7.4a1.6 1.6 0 0 1-1.6-1.6v-15'
    + 'a1.6 1.6 0 0 1 1.6-1.6z M10.4 18.3h3.2',
  repeat:
    'M4.2 10.1a7.8 7.8 0 0 1 13-3.4l2.6 2.4 M19.8 13.9a7.8 7.8 0 0 1-13 3.4l-2.6-2.4'
    + ' M19.8 4.6v4.5h-4.5 M4.2 19.4v-4.5h4.5',
  cross: 'M12 6.6v10.8 M6.6 12h10.8 M5 4.4h14a.6.6 0 0 1 .6.6v14a.6.6 0 0 1-.6.6H5a.6.6 0 0 1-.6-.6V5a.6.6 0 0 1 .6-.6z',
  scissors:
    'M6.4 6.4 17 17 M17 6.4 10.4 13 M7.4 19.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z'
    + ' M16.6 19.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z',
  film:
    'M4.4 5.6h15.2a.8.8 0 0 1 .8.8v11.2a.8.8 0 0 1-.8.8H4.4a.8.8 0 0 1-.8-.8V6.4a.8.8 0 0 1 .8-.8z'
    + ' M10.2 9.4l4.6 2.6-4.6 2.6z',
  bag: 'M6.2 7.6h11.6l1 12.8H5.2z M9.2 7.6V5.4a2.8 2.8 0 0 1 5.6 0v2.2',
  cash:
    'M3.4 6.4h17.2a.7.7 0 0 1 .7.7v9.8a.7.7 0 0 1-.7.7H3.4a.7.7 0 0 1-.7-.7V7.1a.7.7 0 0 1 .7-.7z'
    + ' M12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z',
  bank: 'M3 9.4 12 4.2l9 5.2 M5.4 9.9v7.8 M9.8 9.9v7.8 M14.2 9.9v7.8 M18.6 9.9v7.8 M3.2 20.2h17.6',
  people:
    'M9 11.4a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3.6 19.8c0-2.8 2.4-4.6 5.4-4.6s5.4 1.8 5.4 4.6'
    + ' M16.2 6.2a2.9 2.9 0 0 1 0 5.6 M17 15.6c2 .5 3.4 1.9 3.4 4.2',
  send: 'M4 12.6h12.4 M12.6 8.2l4.4 4.4-4.4 4.4 M20 4.4v16',
  card:
    'M3.4 5.8h17.2a.8.8 0 0 1 .8.8v10.8a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V6.6a.8.8 0 0 1 .8-.8z'
    + ' M2.6 10h18.8 M6 14.6h3.4',
  safe:
    'M4.6 4.6h14.8a.8.8 0 0 1 .8.8v13.2a.8.8 0 0 1-.8.8H4.6a.8.8 0 0 1-.8-.8V5.4a.8.8 0 0 1 .8-.8z'
    + ' M11.2 15.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z M11.2 12h3.2 M17.4 19.4v1.2'
    + ' M6.6 19.4v1.2',
  pin: 'M12 21c3.6-4.4 5.6-7.4 5.6-10A5.6 5.6 0 0 0 6.4 11c0 2.6 2 5.6 5.6 10z M12 12.4a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  cap: 'M2.8 9 12 4.6 21.2 9 12 13.4z M6.6 11.2v4.9c0 1.6 2.4 2.9 5.4 2.9s5.4-1.3 5.4-2.9v-4.9 M20.2 9.4v5',
  fork: 'M7 3.4v7.2a2.2 2.2 0 0 0 4.4 0V3.4 M9.2 10.6v10 M16.8 3.4c-1.4 1.2-2 3-2 5.2 0 1.6.7 2.6 2 2.8v9.2',
  broom: 'M13.8 3.6 9.4 10.4 M7.2 9.4l5.6 3.6-4 6.2-5.6-3.6z M14.6 13.4c2.6-1.3 4-3.4 4.2-6.4',
  gift:
    'M3.8 8.8h16.4v3.4H3.8z M5.2 12.2h13.6v8H5.2z M12 8.8v11.4'
    + ' M12 8.8c-2.6 0-4.4-.7-4.4-2.4S9.4 3.8 12 8.8z M12 8.8c2.6 0 4.4-.7 4.4-2.4S14.6 3.8 12 8.8z',
  question:
    'M9.4 9.2a2.7 2.7 0 1 1 3.6 2.6c-.7.3-1 .9-1 1.8v.6 M12 17.8h.01'
    + ' M12 20.6a8.6 8.6 0 1 0 0-17.2 8.6 8.6 0 0 0 0 17.2z',
  dots: 'M6 12h.01 M12 12h.01 M18 12h.01',
  swap: 'M4 8.6h14 M14.6 5.2 18 8.6l-3.4 3.4 M20 15.4H6 M9.4 12l-3.4 3.4L9.4 18.8',
  tag: 'M11.2 3.4H4.6a1.2 1.2 0 0 0-1.2 1.2v6.6l9 9 7.8-7.8z M7.8 8.2h.01',
  cart:
    'M2.8 4.4h2.6l2.4 11.2h9.8l2.2-8.2H6.2 M9.6 19.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z'
    + ' M16.6 19.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z',
  wrench:
    'M14.7 6.3a4 4 0 0 0 5.2 5.2l-8.4 8.4a1.8 1.8 0 0 1-2.6-2.6l8.4-8.4a4 4 0 0 0-2.6-2.6z'
    + ' M14.7 6.3 17.2 3.8 20.2 6.8 17.7 9.3',
  pill:
    'M13.6 4.6a4.8 4.8 0 0 1 6.8 6.8l-6.6 6.6a4.8 4.8 0 0 1-6.8-6.8z M8.4 9.8l6.8 6.8',
};

/**
 * Which glyph a category or budget line gets. Matched on the WORDS in its
 * name, so a renamed line still finds one, and read top down: the first rule
 * that matches wins, which is why the order below is the design.
 */
const RULES = [
  [/^everything else$|^other$/i, 'dots'],
  [/uncategor/i, 'question'],
  // Before the house rule: "Househelp salary" and "Household Staff" both say
  // "hous", and they are the person who cleans, not the rent.
  [/house ?help|household staff|nanny/i, 'broom'],
  [/rent|hous|mortgage/i, 'house'],
  [/grocer|supermarket|food|market|duka/i, 'basket'],
  [/shop|retail|clothes/i, 'bag'],
  [/gift/i, 'gift'],
  // Fuel before car: a line called "Fuel, transport & car" is about the
  // filling station. "Car & Mechanic" says neither word, so it falls through
  // to the next rule and gets the car. Both matched the one rule before this,
  // which is how the ring ended up with two pumps on it.
  [/transport|fuel|petrol|matatu|uber|fare/i, 'fuel'],
  // Before car: a "car repair" line is repairs, and the car rule would take it.
  [/repair|mainten|fundi|plumb|electrician|servicing/i, 'wrench'],
  [/car\b|mechanic|garage|panel ?beat/i, 'car'],
  [/airtime|data|bundle/i, 'phone'],
  [/internet|wifi|fibre|fiber|online/i, 'wifi'],
  [/electric|power|kplc|token/i, 'bolt'],
  [/water|gas|utilit/i, 'drop'],
  [/family|people|sent|support/i, 'people'],
  [/staff|househelp|nanny|garden|clean/i, 'broom'],
  [/health|pharm|medic|hospital|clinic/i, 'cross'],
  [/personal|salon|barber|care/i, 'scissors'],
  [/entertain|movie|night/i, 'film'],
  [/subscri|netflix|spotify|stream/i, 'repeat'],
  // Not "fee": "Cash, fees & other" is not school fees, and school is named
  // by its own words.
  [/school|educat|tuition|term \d/i, 'cap'],
  [/dining|restaurant|takeaway|eat/i, 'fork'],
  [/sav(e|ing)|invest/i, 'safe'],
  [/loan|credit|debt|repay|fuliza/i, 'card'],
  [/cash|withdraw|atm/i, 'cash'],
  [/gov|licen|tax|permit|fee/i, 'bank'],
  [/land|plot/i, 'pin'],
  [/transfer|pass-?through|internal/i, 'swap'],
  [/lent|lend|loaned/i, 'send'],
];

/**
 * The same set as emoji, which is what Jose wants on the ring: the colour
 * and the character are the phone's, not ours, so they are the same little
 * pictures he already knows from the keyboard. Keyed by GLYPH NAME, so a
 * name resolved by glyphMap - which is what stops two slices sharing one -
 * carries straight over.
 */
const EMOJI = {
  house: '🏠',
  basket: '🧺',
  fuel: '⛽️',
  car: '🚗',
  bolt: '💡',
  drop: '💧',
  wifi: '📡',
  phone: '📱',
  repeat: '🔁',
  cross: '💊',
  scissors: '💇',
  film: '🎬',
  bag: '🛍️',
  cash: '💵',
  bank: '🏛️',
  people: '🤝',
  send: '📤',
  card: '💳',
  safe: '🏦',
  pin: '📍',
  cap: '🎓',
  fork: '🍽️',
  broom: '🧹',
  gift: '🎁',
  question: '❓',
  dots: '⋯',
  swap: '🔄',
  tag: '🏷️',
  cart: '🛒',
  wrench: '🔧',
  pill: '🩹',
};

/** The emoji for a glyph name, or a coin when the name is unknown. */
export const emojiOf = (glyph) => EMOJI[glyph] || EMOJI.tag;

/** The name of the glyph a category gets - "tag" when nothing matches. */
export const glyphFor = (name) => (RULES.find(([re]) => re.test(name || '')) || [0, 'tag'])[1];

/** Every glyph a name matches, best first, then the generic ones. */
const SPARE = ['tag', 'dots', 'swap', 'pin', 'gift', 'send', 'question'];
const allFor = (name) =>
  RULES.filter(([re]) => re.test(name || '')).map(([, g]) => g).concat(SPARE);

/**
 * Glyphs for a whole list at once, no two the same.
 *
 * One rule can honestly cover two different lines - "Car & Mechanic" and
 * "Garage" are both the car - and on a ring that reads as a mistake, because
 * the icon is the only thing saying which slice is which. So a name that
 * wants a glyph already taken falls through to the next rule it matches, and
 * then to a spare. The list is walked in the order given, which everywhere
 * that calls this means biggest first: the big slice keeps the right icon and
 * the small one does the moving.
 */
export function glyphMap(names) {
  const used = new Set();
  const out = {};
  const todo = [...new Set(names)];
  // Everyone with a rule of their own goes first, so a name that matched
  // nothing cannot take the spare that "Everything else" is owed.
  for (const name of todo) {
    const first = RULES.find(([re]) => re.test(name || ''));
    if (first && !used.has(first[1])) {
      used.add(first[1]);
      out[name] = first[1];
    }
  }
  for (const name of todo) {
    if (out[name]) continue;
    const pick = allFor(name).find((g) => !used.has(g)) || 'tag';
    used.add(pick);
    out[name] = pick;
  }
  return out;
}

/**
 * Just the <path> elements, for dropping inside a <g> that already carries the
 * stroke and the transform. A nested <svg> would keep its own viewport and
 * ignore the group's scale, which is how the first draft put a basket the size
 * of the card on the ring.
 */
export const glyphPaths = (name) =>
  (G[name] || G.tag).split(' M').map((d, i) => `<path d="${i ? `M${d}` : d}"/>`).join('');

/** A standalone 24x24 icon, for anywhere that wants an element of its own. */
export const glyphSvg = (name, colour) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="${colour || 'currentColor'}" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphPaths(name)}</svg>`;

/** The two together: a category straight to its drawn icon. */
export const iconFor = (name, colour) => glyphSvg(glyphFor(name), colour);
