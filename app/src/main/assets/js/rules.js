import { SMALL_SEND_LIMIT } from './config.js';

// Categorisation.
//
// Every category belongs to a `class`, which is what keeps the spending picture honest:
//   spending — money genuinely consumed (food, fuel, power)
//   fee      — M-PESA's cut
//   transfer — money moved, not spent (own bank accounts, savings, loan repayments)
//   income   — money in
// The dashboard's headline "spent" figure counts `spending` + `fee` only. A 96k Zenka
// repayment is real, but it is debt servicing; letting it sit in the same bucket as
// groceries would make every other number invisible.

export const CLASSES = { SPENDING: 'spending', FEE: 'fee', TRANSFER: 'transfer', INCOME: 'income' };

// No per-category colors here by design. There are 13 categories — well past the
// 8-hue ceiling where a categorical palette stops being colorblind-distinguishable.
// The category chart's job is comparing magnitude, not telling identities apart, so
// it uses a single-hue sequential ramp ordered by spend. Identity comes from the
// row label sitting next to each bar.
// Mutated in place by registerCustomCategories, never reassigned — every module
// imports this same object, so adding a category makes it appear everywhere at once
// (dropdowns, class lookups, the chart) without any of them re-importing.
export const CATEGORIES = {
  'Rent & Housing': { class: CLASSES.SPENDING },
  Groceries: { class: CLASSES.SPENDING },
  Family: { class: CLASSES.SPENDING },
  'Transport & Fuel': { class: CLASSES.SPENDING },
  'Car & Mechanic': { class: CLASSES.SPENDING },
  // Water, gas, DSTV/GOTV — the shared "utilities" bucket. Electricity is split out
  // below so it can sit on its own budget line (Kenya Power is a bill people watch
  // on its own); everything else utility-ish stays here.
  'Utilities & Power': { class: CLASSES.SPENDING },
  Electricity: { class: CLASSES.SPENDING },
  // Domestic staff paid monthly (househelp, nanny, gardener). No merchant rule can
  // find this — it's a person — so it's populated by tagging that person in
  // Settings → People, which is why it needs to exist as a category to pick.
  'Household Staff': { class: CLASSES.SPENDING },
  Internet: { class: CLASSES.SPENDING },
  Subscriptions: { class: CLASSES.SPENDING },
  'Airtime & Data': { class: CLASSES.SPENDING },
  'Health & Pharmacy': { class: CLASSES.SPENDING },
  'Personal Care': { class: CLASSES.SPENDING },
  Entertainment: { class: CLASSES.SPENDING },
  Shopping: { class: CLASSES.SPENDING },
  'Cash Withdrawal': { class: CLASSES.SPENDING },
  // What a count found missing: cash that went somewhere you did not record.
  // Spending, because it plainly was - naming it is the only thing left undone.
  'Cash (unaccounted)': { class: CLASSES.SPENDING },
  'Government & Fees': { class: CLASSES.SPENDING },
  'Sent to People': { class: CLASSES.SPENDING },
  // Not a guess — an admission. Money genuinely left, so it still counts as spending
  // (understating the total would be worse than admitting ignorance), but it is
  // flagged for you to assign rather than quietly folded into a category it may not
  // belong to.
  Uncategorised: { class: CLASSES.SPENDING },
  // The fundi, the plumber, the oven: money that keeps a thing working. It was
  // landing under "Other Services" with a note saying "oven repair", which is
  // a category doing the job of a note and a note doing the job of a category.
  'Repairs & Maintenance': { class: CLASSES.SPENDING },
  Other: { class: CLASSES.SPENDING },

  'M-PESA Charges': { class: CLASSES.FEE },
  'Bank Charges': { class: CLASSES.FEE },

  'Loans & Credit': { class: CLASSES.TRANSFER },
  'Bank Transfers': { class: CLASSES.TRANSFER },
  'Savings & Investment': { class: CLASSES.TRANSFER },
  // Buying land. Not consumption: the money becomes an asset, and in Jose's
  // case it is paying down a plot already on the debts list - so counting it as
  // spending would put 800,000 into a month's groceries-and-fuel figure and
  // bury everything else. Named on its own line so it is still visible.
  'Land & Plots': { class: CLASSES.TRANSFER },

  // Money you lend to people and expect back. Not spending — it's an asset you're
  // owed — and the repayment isn't income, it's your own money returning. Tagging a
  // person with this catches BOTH directions, and the People ledger nets them off to
  // show what's still outstanding.
  'Money Lent': { class: CLASSES.TRANSFER },
  // Money moving between your own accounts. Excluded from spending AND income —
  // both sides of the movement appear in their respective statements, so counting
  // either would double it.
  'Internal Transfer': { class: CLASSES.TRANSFER },
  // Money that passed through without being yours: someone sent it, you returned it.
  'Pass-through': { class: CLASSES.TRANSFER },

  Income: { class: CLASSES.INCOME },
  // Your pay, kept apart from other money in. It arrives through TerraPay in chunks
  // (M-PESA won't take it in one go) — see js/salary.js, which groups them back into
  // one pay run.
  Salary: { class: CLASSES.INCOME },
  // Money coming back — an insurance payout, an overpayment returned. It arrives
  // like income and should show as money in, but it's worth its own name: it isn't
  // earnings, and it's usually the tail of something you already spent.
  Refunds: { class: CLASSES.INCOME },
};

// The lenders the app recognises, in one place: this both categorises their money as
// borrowing and tells the debts panel what may be worth tracking. Kept as one export
// so those two can never disagree — a name missing here would otherwise be counted as
// income by one and offered as a loan by the other.
export const LENDER_RE =
  /ZENKA|M-?Shwari|M-PESA Overdraw|M-PESA Overdraft|Fuliza|H-\s?Fund|HUSTLER|TALA|BRANCH|KCB M-PESA|\bKORO\b|TIMIZA|MOKASH|ZASH|OKOLEA|MFANISI/i;

// Ordered — first match wins. Built from the merchants actually present in the
// June 2026 data; extend by correcting a transaction in the UI, which appends here.
const BUILT_IN = [
  // Refunds before internal movement: a bank can label a refund "IB Internal
  // Transfer" (its own rail) while the narration says what it actually is. Treating
  // it as internal would hide real money arriving.
  { type: /^Refund$/i, category: 'Refunds' },
  // TENDE B2C is MyCredit's payout rail (confirmed): the 2,500 valuation refund
  // against the 3,000 paid to MYCREDIT LIMITED. Must sit above the bank rules, whose
  // /B2C/ would otherwise claim it as a transfer and hide the money coming back.
  { match: /TENDE B2C/i, category: 'Refunds' },

  // Internal movement: must never be read as spending or income, and its
  // counterparty names ("my M-PESA") would otherwise fall through to merchant rules.
  { type: /^Internal Transfer$/i, category: 'Internal Transfer' },
  { type: /^Pass-?through$/i, category: 'Pass-through' },

  // Fees: unambiguous, and would otherwise be caught by merchant rules.
  { match: /M-PESA Charge/i, category: 'M-PESA Charges' },
  { type: /^(Charge|Transfer Charge|Pay Bill Charge|Merchant Charge)$/i, category: 'M-PESA Charges' },
  { type: /^Bank Charge$/i, category: 'Bank Charges' },

  // No people are named here. Family and friends are yours, not the app's — they
  // live in Settings → People, which creates a name rule per person. Naming someone
  // in the source would publish them along with it.

  // Loans & credit. Disbursements and overdraft credits arrive as money IN, but
  // borrowing is not earning — they must not land in Income.
  // "KCB M-PESA Withdraw" lands in the wallet as money IN and Safaricom writes it as a
  // plain "Withdraw", so it used to read as an agent cash withdrawal — which it isn't
  // (that's cash going OUT). It's a DRAW ON THE KCB M-PESA LOAN: confirmed, and repaid
  // on a later statement. So it's borrowing, which means it belongs to the KCB M-Pesa
  // debt line and must never count as income.
  { match: /KCB\s*M-?PESA\s*Withdrawal/i, category: 'Loans & Credit' },

  // Digital lenders. Money IN from one of these is borrowing, not income — without the
  // name here it falls through to the "inbound = Income" rule and inflates earnings.
  { match: LENDER_RE, category: 'Loans & Credit' },
  { type: /^(Fuliza|Loan Repayment|Loan Disbursement|Overdraft Credit)$/i, category: 'Loans & Credit' },
  // "Ksh X has been credited to your M-PESA account" is how every lender pays out.
  // It could in principle be something else, but this rule sits below all the named
  // ones above, so by the time a credit reaches here nobody has recognised it — and
  // calling an unknown credit borrowing understates earnings, while calling it
  // income overstates them. Understating is the one that cannot flatter.
  { type: /^Credited$/i, category: 'Loans & Credit' },

  // Savings & investment. Matched on name so both directions land here — money in
  // from a fund is a withdrawal of your own capital, not income. Sits above the
  // Income and bank rules, which would otherwise claim the inbound leg.
  { match: /Cytonn|Money Market|MMF|Sanlam|Britam|CIC Asset|M-PESA Savings|NDOVU|WEALTH|ETICA|ZIIDI|MALI\b/i, category: 'Savings & Investment' },
  { type: /^Savings$/i, category: 'Savings & Investment' },

  // Money arriving on a BANK's rail is your own money moving, not income — even when
  // Safaricom types it "Salary Payment".
  //
  // This was the other way round until the NCBA statement arrived and proved it: the
  // NCBA row "Trf to M-pesa <amount> · FTC…" and the M-PESA row "Salary Payment
  // from 504900 - NCBA BANK via API · FTC…" carry the same bank reference. It's one transfer, and counting the M-PESA leg as income inflated
  // earnings by money that was already his. Safaricom labels every bank B2C credit
  // this way regardless of what it is.
  //
  // Sits above the Income rule so the bank name wins over the type.
  // Your salary. It arrives as an international transfer via TerraPay, in several
  // chunks per payday, and is recognised by TerraPay's conversation-ID prefix (TPWT…)
  // rather than the paybill name — because from Sept 2026 it lands through Equity
  // Bank's IMT rail. It MUST sit above the bank rules below: "EQUITY BANK IMT B2C"
  // matches /Equity/, and that rule was filing the pay as a bank transfer.
  { match: /TERRAPAY|TPWT\d{6,}/i, category: 'Salary' },

  { match: /via API|BANK KENYA|NCBA|KCB|Equity|Stanbic|Standard Chartered|SBM|Co-?\s?operative|I&M|IM BANK|DTB|Absa|Family Bank/i, category: 'Bank Transfers' },

  // Income proper: money from outside your own accounts.
  // An inbound international transfer (remittance) is external money arriving.
  { type: /^(Salary Payment|Receive Money|International Transfer)$/i, category: 'Income' },
  // Your own cash going back in at an agent. It was never earnings - counting it
  // as income inflated both sides of the ledger, and the matching 'Cash Deposit'
  // type two rules down had always called it a transfer, so the app disagreed
  // with itself depending on which wording Safaricom used.
  { type: /^Deposit$/i, category: 'Internal Transfer' },

  // Banks and SACCOs — money moving between your own rails, in either direction.
  // Must sit after the loan rules so "KCB M-PESA" (a loan) isn't caught by /KCB/.
  { match: /Equity|NCBA|KCB|Stanbic|Co-?\s?operative Bank|Standard Chartered|SBM Bank|ABSA|DTB|Family Bank|I&M|IM BANK|SACCO|Bank via API|B2C/i, category: 'Bank Transfers' },
  { type: /^Business Payment$/i, category: 'Bank Transfers' },

  // Buying land, above the housing rule - a land vendor's name often carries
  // "PROPERTIES" or "REAL ESTATE", and that rule would file the purchase as
  // rent. Kept to named vendors and the word PLOT rather than anything looser.
  { match: /QUEST REALTY|\bPLOT\b|LAND REGISTR|TITLE DEED/i, category: 'Land & Plots' },

  // Rent & housing
  { match: /NYUMBA LINK|REAL ESTATE|PROPERT|APARTMENT|COURT \d|RENT/i, category: 'Rent & Housing' },

  // Running the car: servicing, repairs, parts, the mechanic. Kept apart from
  // Transport & Fuel so a big repair bill doesn't hide inside normal travel spend.
  // Must precede the transport rule — "AUTOXPRESS" would otherwise match /SHELL|.../
  // ordering by accident and a service station is fuel, not repairs.
  { match: /AUTOXPRESS|AUTO ?DETAILING|AUTO ?BAZAAR|CAR WASH|MECHANIC|GARAGE|SPARE|TYRE|TYRES|MOTORS|AUTO ?SPARES|SERVICE CENTRE|BODY ?SHOP/i, category: 'Car & Mechanic' },

  // Petrol-station cafés carry the FORECOURT's name in the till too — "Artcaffe
  // Rubis South C" — so the fuel rule below (/RUBIS/) would wrongly book a coffee as
  // fuel. Name the known café brands first; kept to real chains so nothing else is
  // swept in.
  { match: /ARTCAFF?E|JAVA\s*HOUSE|DORMANS|NAIROBI\s*JAVA/i, category: 'Entertainment' },

  // Places, not people. A merchant's name usually says what it is, and a till
  // in a mall or a supermarket is the single most common thing left sitting in
  // the uncategorised list. These are deliberately about the VENUE - a name
  // with GARDEN CITY or SARIT in it is a mall, and whatever was bought there,
  // Shopping is a better answer than nothing at all.
  { match: /GARDEN CITY|SARIT|VILLAGE MARKET|TWO RIVERS|THE HUB|GALLERIA|YAYA|JUNCTION MALL|WESTGATE|GREENSPAN|THIKA ROAD MALL|\bTRM\b|PRESTIGE PLAZA|CAPITAL CENTRE|LIKONI MALL|NEXUS MALL/i, category: 'Shopping' },
  // CARRERFOUR, with the extra R, is how the till itself spells it.
  { match: /NAIVAS|QUICKMART|CARRE?R?FOUR|CHANDARANA|CLEANSHELF|MAGUNAS|EASTMATT|SOKO|GREENMART|KASSMATT|MATHAIS|ZUCCHINI|SUPERMARKET|GROCER/i, category: 'Groceries' },
  { match: /PHARMAC|CHEMIST|GOODLIFE|MEDPLUS|HOSPITAL|CLINIC|DENTAL|OPTICA|LABORATOR/i, category: 'Health & Pharmacy' },
  { match: /\bSHELL\b|TOTAL\s*ENERG|TOTALENERGIES|RUBIS|OILIBYA|\bOLA\b ENERGY|PETROL|SERVICE STATION|\bGAPCO\b|\bHASS\b|ASTROL/i, category: 'Transport & Fuel' },
  { match: /\bMAF\b|\bH ?& ?M\b|LC WAIKIKI|MR PRICE|WOOLWORTH|\bBATA\b|DECATHLON|TRUWORTH|\bJUMIA\b|\bKILIMALL\b|BOOKSHOP|STATIONER/i, category: 'Shopping' },
  { match: /SALON|BARBER|SPA\b|BEAUTY|COSMETIC|NAIL/i, category: 'Personal Care' },
  { match: /CINEMA|IMAX|CENTURY|ANGA|BOWLING|GOLF|\bGYM\b|FITNESS|CLUB\b|LOUNGE|WINES|SPIRITS|LIQUOR/i, category: 'Entertainment' },

  // Getting around: fuel, tolls, parking, taxis
  { match: /MOJA EXPRESSWAY|SHELL|TOTAL|ASTROL|PETROL|OILIBYA|RUBIS|UBER|BOLT|LITTLE CAB|MATATU|SGR|KENYA RAILWAY|SERVICE STATION|PARKNGO|PARKING/i, category: 'Transport & Fuel' },

  // Card subscriptions — these hit the bank card directly and never touch M-PESA,
  // so they are invisible in an M-PESA-only view.
  { match: /SPOTIFY|OPENAI|CHATGPT|NETFLIX|GOOGLE|YOUTUBE|APPLE|MICROSOFT|ADOBE|AMAZON PRIME|CLAUDE|ANTHROPIC/i, category: 'Subscriptions' },

  // Groceries
  { match: /NAIVAS|QUICK ?MART|CARREFOUR|CHANDARANA|TUSKYS|MAJID|KUKU|BUTCHER|GREENGROCER|SOKO|MILLERS|MEAT COMM|\bMEAT\b|GROCER|SUPERMAR/i, category: 'Groceries' },

  // Dining
  { match: /DOMINO|PIZZA|JAVA|ARTCAFF?E|KFC|BURGER|CHICKEN INN|PRONTO CATERING|CAF[EÉ]|RESTAURANT|KIBANDA|HOTEL|GALITOS|SUBWAY|JUICY LIME|GRILL|FLAVOR TOWN|EATERY|FOOD/i, category: 'Entertainment' },

  // Health
  { match: /HOSPITAL|PHARMA|CLINIC|MEDIC|CHEMIST|DOCTOR|DENTAL|OPTIC|HEART FUND|AFYA|HEALTH/i, category: 'Health & Pharmacy' },

  // Personal care
  { match: /SALON|BARBER|SPA|BEAUTY|HAIR/i, category: 'Personal Care' },

  // Entertainment
  { match: /CINEMA|GAMING|CINEMAX|BETIKA|SPORTPESA|ODIBETS|CLUB|LOUNGE/i, category: 'Entertainment' },

  // Home internet. Safaricom Home appears as both SAFARICOMHOME and SAFARICOM HOME
  // (two different paybills: 150501 and 522006).
  { match: /SAFARICOM ?HOME|ZUKU|JTL|FAIBA|POA INTERNET|SURF/i, category: 'Internet' },

  // Electricity — Kenya Power / KPLC / the prepaid token paybills. Split out from the
  // utilities bucket so it can carry its own budget line. Must sit ABOVE the utilities
  // rule (first match wins) or /KENYA POWER/ would be swallowed there.
  // Kept tight on purpose: "STIMA" (Stima Sacco) and "TOKEN" would false-positive.
  // \s+ not a literal space — pdf.js emits double spaces where the SMS has one.
  { match: /KPLC|KENYA\s+POWER/i, category: 'Electricity' },

  // Utilities & power — water, gas, pay-TV. Electricity handled above.
  { match: /NAIROBI\s+WATER|WATER\s+CO|GOTV|DSTV|STARTIMES/i, category: 'Utilities & Power' },

  // Airtime & data
  { match: /Safaricom Data Bundles|Safaricom Airtime|^Safaricom$/i, category: 'Airtime & Data' },
  { type: /^(Airtime Purchase|Data Bundle Purchase|Data Bundle Recharge)$/i, category: 'Airtime & Data' },

  // Cash out at an agent
  { type: /^Withdrawal$/i, category: 'Cash Withdrawal' },

  // Money landing in the bank account, read from the bank's own text message.
  // Deliberately NOT income by default: a deposit might be pay arriving, or it
  // might be his own money moving in, and the text does not say which. Filed as
  // a transfer so it can never inflate earnings on a guess - one tap on the row
  // makes it Salary or Income for good if that is what it is.
  { type: /^Bank Deposit$/i, category: 'Bank Transfers' },

  // A card payment with no merchant in the text ("for the sum of KES 10,690.33"
  // and nothing else) can only be named after the card. It is real spending and
  // it is unassigned, which is exactly what the triage list is for.
  { match: /^Card payment$/i, category: 'Uncategorised' },

  // Cash IN at an agent. Not income: it is money you already had, in your hand,
  // moving into the wallet — and it is very often the cash you withdrew earlier
  // going back in. Counting it as money received would book the same money twice.
  { type: /^Cash Deposit$/i, category: 'Internal Transfer' },

  // Government & statutory
  { match: /COUNTY GOVERNMENT|KRA|NHIF|SHA|NSSF|e-?CITIZEN|NTSA|REVENUE|CREDIT REFERENCE|METROPOL/i, category: 'Government & Fees' },

  // Shopping / retail
  { match: /JUMIA|KIDDIE|WAIKIKI|MALL|HOUSE OF LEATHER|RONICE INDUSTRIES|SHOP|STORE|BOUTIQUE|ELECTRONI|KLOSET|RETAIL/i, category: 'Shopping' },

  // Payment aggregators — genuinely ambiguous (they front for many merchants), so
  // they land in Shopping rather than pretending to know. Correct one in the UI and
  // the rule sticks for that merchant.
  { match: /iPay|EVOPAY|PESAPAL|JAMBOPAY|FLUTTERWAVE|TINGG|GlobalPay/i, category: 'Shopping' },
];

// A person-to-person send: counterparty looks like a masked phone number + name.
const PERSON_RE = /^(?:254)?0?7[\d*]{6,}\s|^\d{2,4}\*+\d{2,4}\s/;

// Name rules are matched LONGEST-FIRST, not in the order they were created.
//
// "JANE DOE" and "DOE" both match the same transactions. In creation order,
// whichever was added first wins — so a broad surname rule silently shadows the
// specific person you set afterwards, and the UI still reports success while nothing
// changes. Longest match = most specific = intended.
//
// Cached because this runs per transaction; the length check catches a rule being
// pushed onto the same array, and any other edit replaces the array outright.
const sortCache = new WeakMap();
function specificFirst(nameRules) {
  if (!nameRules || nameRules.length < 2) return nameRules || [];
  const hit = sortCache.get(nameRules);
  if (hit && hit.length === nameRules.length) return hit;
  const sorted = [...nameRules].sort((a, b) => (b.match || '').length - (a.match || '').length);
  sortCache.set(nameRules, sorted);
  return sorted;
}

export function categorise(txn, userRules = [], nameRules = []) {
  const hay = `${txn.counterparty || ''} ${txn.account || ''}`.trim();

  // Most specific first: a rule you set on one exact counterparty beats a name
  // fragment, which in turn beats the built-in merchant rules — otherwise a person
  // whose till is named "FRANK'S BUTCHERY" could never be moved out of Groceries.
  for (const rule of userRules) {
    if (rule.counterparty && rule.counterparty.toLowerCase() === (txn.counterparty || '').toLowerCase()) {
      return { category: rule.category, source: 'user' };
    }
  }

  const lower = hay.toLowerCase();
  for (const rule of specificFirst(nameRules)) {
    if (rule.match && lower.includes(rule.match.toLowerCase())) {
      return { category: rule.category, source: 'name' };
    }
  }

  for (const rule of BUILT_IN) {
    if (rule.match && rule.match.test(hay)) return { category: rule.category, source: 'rule' };
    if (rule.type && rule.type.test(txn.type || '')) return { category: rule.category, source: 'rule' };
  }

  if (txn.direction === 'In') return { category: 'Income', source: 'fallback' };

  const bareNumber = /^\d{9,15}$/.test((txn.counterparty || '').trim());
  const isPerson =
    PERSON_RE.test(hay) || bareNumber || txn.type === 'Customer Transfer' || txn.type === 'Bank to M-PESA';

  if (isPerson) {
    // Small sends to people are reliably food, so that guess stays. Everything above
    // the limit is left Uncategorised: guessing at ALL person-sends once swallowed
    // 56% of spending and made Groceries meaningless — a plausible guess at that
    // scale isn't a guess any more, it's misinformation. The size cap keeps the
    // convenience without the lie.
    if (txn.direction === 'Out' && txn.amount <= SMALL_SEND_LIMIT) {
      return { category: 'Groceries', source: 'small-send' };
    }
    return { category: 'Uncategorised', source: 'fallback' };
  }

  // A small payment at a till is food for the same reason a small send is: at
  // sixty or a hundred shillings it is kale, a mandazi, a bunch of bananas. The
  // same limit guards it, and it is YOUR limit - set it to zero in Settings and
  // this stops guessing entirely. Above the limit nothing is assumed: a plausible
  // guess at scale is not a guess any more, it is misinformation.
  if (txn.direction === 'Out' && txn.amount > 0 && txn.amount <= SMALL_SEND_LIMIT) {
    return { category: 'Groceries', source: 'small-till' };
  }
  return { category: 'Uncategorised', source: 'fallback' };
}

const BUILT_IN_NAMES = Object.keys(CATEGORIES);

export const isBuiltInCategory = (name) => BUILT_IN_NAMES.includes(name);

/** Add the user's own categories to the live registry. Built-ins can't be shadowed. */
export function registerCustomCategories(list = []) {
  for (const name of Object.keys(CATEGORIES)) {
    if (!BUILT_IN_NAMES.includes(name)) delete CATEGORIES[name];
  }
  for (const c of list) {
    if (!c || !c.name || BUILT_IN_NAMES.includes(c.name)) continue;
    CATEGORIES[c.name] = { class: c.class || CLASSES.SPENDING, custom: true };
  }
}

/**
 * The human part of a counterparty, which is what a rule should key on:
 *   "254727***052 JANE DOE" -> "JANE DOE"
 *   "6454462 - TOP SERVICES"         -> "TOP SERVICES"
 * The masked number differs between an SMS and a statement; the name doesn't.
 */
export function personName(counterparty) {
  const s = String(counterparty || '').trim();
  const till = s.match(/^[\d*]+\s*-\s*(.+)$/); // paybill / till
  if (till) return till[1].trim();
  const person = s.match(/^(?:254|0)?[\d*]{5,}\s+(.+)$/); // masked phone + name
  if (person) return person[1].trim();
  return s;
}

/**
 * Categories that describe ONE movement, not a merchant.
 *
 * "Someone sent me 20,000 to pass on" is a fact about that payment, not about that
 * person — they'll send you normal money next week. Choosing one of these on a row
 * therefore marks only that row, instead of writing a name rule that would quietly
 * reclassify everything they ever send you.
 */
export const ONE_OFF_CATEGORIES = new Set(['Pass-through', 'Internal Transfer']);

export function classOf(category) {
  return CATEGORIES[category]?.class ?? CLASSES.SPENDING;
}

/**
 * A transaction as one-or-more (category, amount) parts.
 *
 * Normally it's just itself. When it has been split across categories (store.splits),
 * this returns one shallow clone per part, each carrying its own slice of the amount
 * and its own category. Every place that totals spending by category iterates these,
 * so a split reconciles in the budget, the category chart and the monthly report
 * without any of them needing to know splits exist. Balance and reconciliation must
 * NOT use this — to them the transaction was a single movement.
 */
export function categoryParts(t) {
  const s = t && t.splits;
  if (!Array.isArray(s) || s.length === 0) return [t];
  // A slice counts toward its own `month` if set, else the transaction's whole-txn
  // budget month, else (in budgetReport) its date. Carried as `budgetMonth`.
  return s.map((p) => ({
    ...t,
    amount: p.amount,
    category: p.category,
    budgetMonth: p.month || t.budgetMonth || null,
    _part: true,
  }));
}

export const _internals = { BUILT_IN, PERSON_RE };
