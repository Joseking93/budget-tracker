// Parses raw M-PESA SMS text into structured transactions.
//
// Every transaction is keyed by its M-PESA receipt code (e.g. UFT8N9M0TA), which
// Safaricom guarantees unique. That code is what lets a pasted SMS and the same
// transaction arriving later in a statement collapse into one record.
//
// Anything we cannot parse is returned in `unparsed` rather than dropped, so the
// UI can show it. Silently swallowing a message would quietly understate spending.
//
// Patterns use NAMED groups, not positions. The withdrawal pattern used to read
// its amount from group 3 and its agent from group 4 while the regex actually put
// the time and the amount there — so every withdrawal read from an SMS was filed
// as "Ksh 2.00 from 1,000.00". Positional groups make that mistake invisible;
// named ones make it impossible.

import { isMyName } from './config.js';

const CUR = String.raw`(?:Kshs?|KES)\s?`;
const NUM = String.raw`[\d,]+(?:\.\d{1,2})?`;
const RECEIPT = String.raw`(?<rcpt>[A-Z0-9]{10})`;
// Safaricom is inconsistent about the gap after "Confirmed" — sometimes a full
// stop, sometimes a newline, sometimes nothing at all.
const CONF = `${RECEIPT}\\s*[Cc]onfirmed[.\\s]*`;
const DATE = String.raw`(?<d>\d{1,2}\/\d{1,2}\/\d{2,4})`;
const TIME = String.raw`(?<t>\d{1,2}:\d{1,2}\s?(?:[AP]\.?M\.?)?)`;
const AT = `on\\s+${DATE}\\s*(?:at\\s*)?${TIME}`;
// Every balance line, whether the message says "New M-PESA balance" (most of them)
// or just "M-PESA balance" (the Fuliza repayments).
const BAL = `(?:New |Your )?M-?PESA balance is`;

const amt = (name) => `${CUR}(?<${name}>${NUM})`;

function money(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/[.,]$/, '').trim();
}

// M-PESA writes dates as d/m/yy and times as "8:36 AM". Kenya is UTC+3 with no DST.
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const [d, m, y] = dateStr.split('/').map((n) => parseInt(n, 10));
  const year = y < 100 ? 2000 + y : y;
  let hour = 0;
  let minute = 0;
  const t = String(timeStr || '').match(/(\d{1,2}):(\d{1,2})\s*([AP])?/i);
  if (t) {
    hour = parseInt(t[1], 10);
    minute = parseInt(t[2], 10);
    const mer = (t[3] || '').toUpperCase();
    if (mer === 'P' && hour !== 12) hour += 12;
    if (mer === 'A' && hour === 12) hour = 0;
  }
  return new Date(Date.UTC(year, m - 1, d, hour - 3, minute)).toISOString();
}

// Ordered most-specific first: "sent to X for account Y" must beat plain "sent to X".
const PATTERNS = [
  {
    type: 'Pay Bill',
    direction: 'Out',
    // The account number runs to " on <date>" rather than matching a character
    // class. It is printed verbatim from the biller and carries dots, hashes,
    // colons and spaces; when the class guessed wrong the message fell through to
    // "sent to" and lost the account entirely.
    re: new RegExp(`${CONF}${amt('amt')} sent to (?<who>.+?) for account (?<acct>.+?) ${AT}`, 'i'),
  },
  {
    type: 'Merchant Payment',
    direction: 'Out',
    re: new RegExp(`${CONF}${amt('amt')} paid to (?<who>.+?)[.\\s]*${AT}`, 'i'),
  },
  {
    type: 'Customer Transfer',
    direction: 'Out',
    re: new RegExp(`${CONF}${amt('amt')} sent to (?<who>.+?) ${AT}`, 'i'),
  },
  {
    type: 'Receive Money',
    direction: 'In',
    re: new RegExp(`${CONF}You have received ${amt('amt')} from (?<who>.+?) ${AT}`, 'i'),
  },
  {
    // Loan disbursements and some bank credits arrive this way. Money in, but
    // borrowing is not earning — rules.js files the known lenders under credit.
    type: 'Credited',
    direction: 'In',
    re: new RegExp(
      `${CONF}${amt('amt')} has been credited to your M-PESA account from (?<who>.+?)[.\\s]*${AT}`,
      'i'
    ),
  },
  {
    // The same, from no one in particular.
    type: 'Credited',
    direction: 'In',
    re: new RegExp(`${CONF}${amt('amt')} has been credited to your M-PESA account[.\\s]*${AT}`, 'i'),
    who: 'M-PESA Credit',
  },
  {
    // "Your loan repayment of Ksh2,716.00 from your M-PESA account to KCB
    // M-PESA on 24/8/22 at 2:00 PM is successful."
    type: 'Loan Repayment',
    direction: 'Out',
    re: new RegExp(
      `${CONF}Your loan repayment of ${amt('amt')} from your M-PESA account to (?<who>.+?) ${AT}`,
      'i'
    ),
  },
  {
    // "Loan of Ksh2,150.00 repaid from M-PESA on 5/4/24 at 5:36 PM." Nobody is
    // named, so it carries the only thing the message says it is.
    type: 'Loan Repayment',
    direction: 'Out',
    re: new RegExp(
      `${CONF}Loan of ${amt('amt')} repaid from\\s+(?:your\\s+)?(?<who>[A-Za-z0-9&\\-. ]*?)(?:\\s+account)?\\s+${AT}`,
      'i'
    ),
    who: 'Loan',
    after: (t, g) => {
      // "repaid from M-PESA" names the wallet it came out of, not a lender.
      if (!g.who || /^M-?PESA$/i.test(clean(g.who))) t.counterparty = 'Loan';
    },
  },
  {
    // "Your M-Shwari loan has been approved on 24/3/24 3:35 PM and Ksh1,970.00
    // less excise duty has been deposited to your M-PESA account." Money in,
    // and rules.js files the lender under credit rather than income.
    type: 'Loan Disbursement',
    direction: 'In',
    re: new RegExp(
      `${CONF}Your (?<who>[A-Za-z0-9&\\-. ]+?) loan has been approved ${AT} and ${amt('amt')}`,
      'i'
    ),
  },
  {
    // "You have transfered Ksh500.00 from your KCB M-PESA account on ..." -
    // with one r, which is how Safaricom spells it. 140 of these sat in the
    // not-recognised panel through three releases, because the pattern was
    // written from the spelling a person would use.
    // FROM the savings or loan account means money arriving in the wallet.
    type: 'Savings',
    direction: 'In',
    re: new RegExp(
      `${CONF}You have transferr?ed ${amt('amt')} (?<dir>to|from) your (?<who>[A-Za-z0-9&\\-. ]+?) account(?:[.\\s]*${AT})?`,
      'i'
    ),
    after: (t, g) => {
      t.direction = /^from$/i.test(g.dir) ? 'In' : 'Out';
      t.counterparty = clean(g.who) || 'M-PESA Savings';
    },
  },
  {
    // "You have sent Ksh800.52 to Hustler Fund on 28/12/2022  at 05:20 PM."
    type: 'Customer Transfer',
    direction: 'Out',
    re: new RegExp(`${CONF}You have sent ${amt('amt')} to (?<who>.+?) ${AT}`, 'i'),
  },
  {
    type: 'Withdrawal',
    direction: 'Out',
    re: new RegExp(`${CONF}${AT}\\s*Withdraw ${amt('amt')} from (?<who>.+?)\\s*${BAL}`, 'i'),
  },
  {
    // Cash handed over at an agent. Money IN to the wallet, but it is your own
    // cash arriving, not earnings — rules.js keeps it out of income and spending
    // both, the same way a transfer between your own accounts is kept out.
    type: 'Cash Deposit',
    direction: 'In',
    re: new RegExp(`${CONF}${AT}\\s*Give ${amt('amt')} cash to (?<who>.+?)\\s*${BAL}`, 'i'),
  },
  {
    type: 'Deposit',
    direction: 'In',
    re: new RegExp(`${CONF}${amt('amt')} deposited to your M-PESA account[.\\s]*${AT}`, 'i'),
    who: 'M-PESA Deposit',
  },
  {
    type: 'Airtime Purchase',
    direction: 'Out',
    re: new RegExp(
      `${CONF}You bought ${amt('amt')} of airtime(?: for (?<who>\\+?\\d+))?[.\\s]*${AT}`,
      'i'
    ),
    who: 'Safaricom Airtime',
    whoPrefix: 'Safaricom Airtime for ',
  },
  {
    type: 'Data Bundle Purchase',
    direction: 'Out',
    re: new RegExp(
      `${CONF}You bought ${amt('amt')} of (?:data bundles?|data|bundles?)(?: for \\+?\\d+)?[.\\s]*${AT}`,
      'i'
    ),
    who: 'Safaricom Data Bundles',
  },
  {
    // Anything else bought straight from the wallet, named by what it was.
    type: 'Purchase',
    direction: 'Out',
    re: new RegExp(`${CONF}You bought ${amt('amt')} of (?<who>[^.\\n]+?)[.\\s]*${AT}`, 'i'),
  },
  {
    // M-Shwari, KCB M-PESA, M-PESA savings — one shape, many products. The product
    // name comes out of the message rather than being listed here, so a new
    // savings rail does not need a code change to be read.
    type: 'Savings',
    direction: 'Out',
    re: new RegExp(
      `${CONF}${amt('amt')} transferr?ed (?<dir>to|from) (?<who>[A-Za-z0-9&\\-. ]*?)\\s*account[.\\s]*(?:${AT})?`,
      'i'
    ),
    after: (t, g) => {
      t.direction = /^from$/i.test(g.dir) ? 'In' : 'Out';
      t.counterparty = clean(g.who) || 'M-PESA Savings';
    },
  },
  {
    // "Ksh 42.54 from your M-PESA has been used to fully pay your outstanding
    // Fuliza M-PESA." These carry NO date and no "New" on the balance line, which
    // is why hundreds of them were landing in the not-recognised pile. The date
    // comes from the message's own timestamp, which the phone now hands over.
    type: 'Loan Repayment',
    direction: 'Out',
    re: new RegExp(
      `${CONF}${amt('amt')} from your M-PESA (?:account )?has been used to (?:fully |partially )?(?:repay|pay)(?: your)?(?: outstanding)? (?<who>[^.\\n]+?)(?:[.\\n]|$)`,
      'i'
    ),
  },
  {
    // "Reversal of transaction X has been successfully reversed on 19/11/22 at
    //  6:12 PM and Ksh150.00 is credited to your M-PESA account." The date
    //  comes BEFORE the amount here, which the pattern below cannot read.
    type: 'Refund',
    direction: 'In',
    re: new RegExp(
      `${CONF}[^]*?reversed[^]*?${AT}\\s+and\\s+${amt('amt')} (?:is|has been) credited`,
      'i'
    ),
    who: 'M-PESA Reversal',
  },
  {
    // The same sentence the other way round: a payment TO him reversed, so the
    // money goes back out again.
    type: 'Refund',
    direction: 'Out',
    re: new RegExp(
      `${CONF}[^]*?reversed[^]*?${AT}\\s+and\\s+${amt('amt')} (?:is|has been) debited`,
      'i'
    ),
    who: 'M-PESA Reversal',
  },
  {
    // Money coming back after a reversal. The reversed receipt is in the text, but
    // this transaction has its own, so the two never collide.
    type: 'Refund',
    direction: 'In',
    re: new RegExp(
      `${CONF}[^]*?${amt('amt')} has been (?:returned|reversed)[^]*?${AT}`,
      'i'
    ),
    who: 'M-PESA Reversal',
  },
];


/* ──────────────────────────────────────────────────────────────────────────
   The banks
   ──────────────────────────────────────────────────────────────────────────
   What a bank adds is what the wallet cannot see: a card payment, and money
   landing in the account. Almost everything else it texts about is the other
   side of a movement M-PESA has already recorded — often quoting M-PESA's own
   receipt in the text — so storing it would count the same money twice. Those
   are recognised and deliberately not stored; see BANK_ECHOES.
   ────────────────────────────────────────────────────────────────────────── */
const BANK_PATTERNS = [
  {
    // "Thank you for using your Standard Chartered card ending 4981 on
    //  21-04-23 for the sum of KES 10690.33." No merchant named, so the card
    //  is the only thing it can be called.
    type: 'Card Payment',
    direction: 'Out',
    re: new RegExp(
      `using your .*?card ending (?<card>\\d+) on (?<dmy>\\d{2}-\\d{2}-\\d{2}) for the sum of ${amt('amt')}`,
      'i'
    ),
    who: 'Card payment',
  },
  {
    // "KES 2624.84 has been paid to Wise 188-89083833 US using your SCB Debit
    //  Card No. 3243 on 2023-01-25."
    type: 'Card Payment',
    direction: 'Out',
    re: new RegExp(
      `${amt('amt')} has been paid to (?<who>.+?) using your .*?Card No\\.? ?(?<card>\\d+) on (?<iso>\\d{4}-\\d{2}-\\d{2})`,
      'i'
    ),
  },
  {
    // "Confirmed! You have received KES 16,850.00 from SADIA NYAWIRA HASSAN -
    //  129****338 at 2026-07-22 10:09:47 AM via KCB." Money into the bank from
    //  a person — unless the person is him, in which case it is his own money
    //  moving and must not be counted as anything arriving.
    type: 'Receive Money',
    direction: 'In',
    re: new RegExp(
      `You have received ${amt('amt')} from (?<who>.+?) at (?<ymd>\\d{4}-\\d{2}-\\d{2}) (?<ymdt>[\\d:]+\\s?[AP]M)`,
      'i'
    ),
    after: (t, g) => {
      if (isMyName(g.who)) {
        t.type = 'Internal Transfer';
        t.counterparty = 'Between my own accounts';
      }
    },
  },
  {
    // "Your SEND TO PESALINK request of KES 20,000.00 from 120****913 to
    //  011****177 - JOSPHAT KINGORI WAMBUGU at 2026-03-07 01:11:11 PM has been
    //  processed successfully." Money out of the bank to a person.
    type: 'Bank Payment',
    direction: 'Out',
    re: new RegExp(
      `SEND TO PESALINK request of ${amt('amt')} from \\S+ to (?<who>.+?) at (?<ymd>\\d{4}-\\d{2}-\\d{2}) (?<ymdt>[\\d:]+\\s?[AP]M)`,
      'i'
    ),
  },
  {
    // "Your KPLC TOKEN PURCHASE request of KES 1,000.00 from 120****913 to
    //  KPLC - 37152141497 at 2025-10-01 08:34:06 AM has been processed."
    //  Electricity, bought from the bank, invisible to the wallet.
    type: 'Pay Bill',
    direction: 'Out',
    re: new RegExp(
      `(?<who>[A-Z]+) TOKEN PURCHASE request of ${amt('amt')} from \\S+ to [^-]+- ?(?<acct>\\d+) at (?<ymd>\\d{4}-\\d{2}-\\d{2}) (?<ymdt>[\\d:]+\\s?[AP]M)`,
      'i'
    ),
  },
  {
    // "Dear Client, transaction of KES 4250.00 to AIRTELMONEY has been
    //  processed successfully, ref. 13740273116". The same sentence ending in
    //  MPESA is an echo and never reaches here.
    type: 'Bank Payment',
    direction: 'Out',
    re: new RegExp(`transaction of ${amt('amt')} to (?<who>.+?) has been processed successfully`, 'i'),
  },
  {
    // "Dear Client, KES 15086.30 has been credited to your Acc. ending with
    //  7700." Money arriving in the bank that the wallet never sees. The same
    //  sentence ending "from MPESA" is an echo and never reaches here.
    type: 'Bank Deposit',
    direction: 'In',
    re: new RegExp(
      `${amt('amt')} (?:has been credited to|received in) your (?:Acc\\.?|account) ending (?:with )?(?<acct>\\d+)`,
      'i'
    ),
    who: 'Bank deposit',
  },
  {
    // "Your local funds transfer request of KES 50,048.00 to Josephat Kingor
    //  has been processed successfully." The one that names who was paid.
    type: 'Bank Payment',
    direction: 'Out',
    re: new RegExp(
      `funds transfer request of ${amt('amt')} to (?<who>.+?) (?:has been |is )processed`,
      'i'
    ),
  },
  {
    // "KES 114897.00 was transferred from Acc. ending with 7700 to Acc. ending
    //  with 9581." Between his own accounts: real, but not spending.
    type: 'Internal Transfer',
    direction: 'Out',
    re: new RegExp(
      `${amt('amt')} was transferr?ed from (?:Acc\\.?|account) ending (?:with )?(?<acct>\\d+) to (?:Acc\\.?|account) ending (?:with )?(?<to>\\d+)`,
      'i'
    ),
    who: 'Between my own accounts',
  },
  {
    // "9JU9F39ZLL Completed. KES 20.00 airtime Purchase for 254… on 30/10/2022
    //  at 7:13 PM." Bought from the bank, so the wallet never sees it.
    type: 'Airtime Purchase',
    direction: 'Out',
    re: new RegExp(`${amt('amt')} airtime Purchase for \\d+ on ${DATE} at ${TIME}`, 'i'),
    who: 'Airtime',
  },
  {
    // "Dear Client, a transaction of KES 549.00 was made on card ending 6621
    //  at Google Spotify Music on 2026-09-30."
    // The one kind of spending that never touches the wallet at all.
    type: 'Card Payment',
    direction: 'Out',
    re: new RegExp(
      `transaction of ${amt('amt')} was made on card ending (?<card>\\d+) at (?<who>.+?) on (?<iso>\\d{4}-\\d{2}-\\d{2})`,
      'i'
    ),
  },
  {
    // "Dear Client, KES 446900.25 has been deposited to Acc. ending with 7700."
    // No date in the text, so it takes the message's own.
    type: 'Bank Deposit',
    direction: 'In',
    re: new RegExp(`${amt('amt')} has been deposited to Acc\\.? ending (?:with )?(?<acct>\\d+)`, 'i'),
    who: 'Bank deposit',
  },
];

/**
 * A bank describing money the wallet has already recorded.
 *
 * Both halves of a bank-to-wallet transfer get their own text, and one of them
 * usually quotes the M-PESA receipt, so there can be three messages for one
 * movement. The wallet's own message is the better record of it — it names the
 * counterparty and carries the fee — so these are read, counted as recognised,
 * and not stored. Not storing them is the whole point: it is the only way the
 * same money cannot be counted twice.
 */
const BANK_ECHOES = [
  // Anything quoting the wallet's own receipt is the wallet's movement, seen
  // from the other side. The colon is not always there.
  /M-?PESA\s+Ref/i,
  /to\s+MPESA has been processed/i,
  /transferr?ed .* to your MPESA Account/i,
  /sent to M-?PESA \d/i,
  /credited to your (?:Acc\.?|account) ending (?:with )?\d+ from M-?PESA/i,
  /received in (?:Acc\.?|account) ending (?:with )?\d+ from M-?PESA/i,
  /await M-?PESA notification/i,
  /BNPL REPAYMENT/i,
  /withdrawn from (?:Acc\.?|account) ending/i,

  // Borrowing, tracked through the wallet. The loan is created here and drawn
  // in M-PESA; counting both would double every shilling borrowed.
  /MOBI LOAN/i,
  /to KCB Mobile Loan has been received/i,
  /to VOOMA Loan has been received/i,
  /loan (?:No\.?|number)?\s*\d+ is now fully paid/i,
  /loan .*(?:has been|was) (?:approved|processed)/i,
  /credited to your KCB Account/i,
  /sent to your KCB M-?PESA Account/i,
  /has been partially paid/i,
  /request to refinance/i,

  // Nothing moved.
  /has failed/i,
  /cannot be completed/i,
  /been declined/i,
  /^Failed\./i,
  /loan request/i,
  /is now being processed/i,

  // Offers, limits, balances and reminders.
  /total limit is/i,
  /credit limit is/i,
  /loan limit is/i,
  /you qualify for/i,
  /borrow (?:now|today)/i,
  /\bSTOP ?\*\d/i,
  /Actual balance/i,
  /balance is\s+KES [\d,.]+\s+on/i,
  /balance of KES [\d,.]+ is due/i,
  /outstanding .*Loan due on/i,
  /repayment period/i,
  /existing loan of/i,
  /repayment of KES [\d,.]+ is due/i,
  /please repay/i,
];

// A Fuliza draw rides along with whatever transaction it funded, so it is read
// separately rather than as one of the shapes above.
const FULIZA_RE = new RegExp(`${CONF}[^]*?Fuliza M-PESA amount is ${amt('amt')}`, 'i');

// Recognised, but not money moving. These are not failures and must not be listed
// as "could not read" — doing that is what turned the panel into a wall of noise.
const NOT_A_TRANSACTION = [
  /M-PESA balance was/i,
  // "Your KCB M-PESA balance is: 1. Saving Account; 1.27 at 7:29 PM."
  /balance is:\s*\d\./i,
  /balance (?:enquiry|inquiry)/i,
  /has been registered/i,
  /Fuliza M-PESA limit (?:has been|is now|increased|decreased)/i,
  /you have requested a statement/i,
  /your statement (?:is|has been)/i,
  /PIN (?:has been|was) (?:changed|reset)/i,
  /opted (?:in|out)/i,
  /loan request will be processed/i,
  /loan (?:application|request) (?:was|has been) (?:received|declined|rejected)/i,
  /you (?:do not|don't) have enough/i,
  // "Your account balance was: M-PESA Account : Ksh16,665.52 on 20/6/24"
  /account balance was/i,
  // "Your loan limit is 2500.00. A fee of 8.64% ..." - terms, not a payment.
  /loan limit is/i,
  /do not qualify/i,
  /loan (?:no\.?|number)?\s*\d+ is now fully paid/i,

  // Advertising. A lender with your number sends a great deal of it, and none
  // of it is money.
  /need extra cash/i,
  /pata extra cash/i,
  /more bills\?/i,
  /sort your financial needs/i,
  /do not miss out/i,
  /amazing offer/i,
  /cashback/i,
  /worry not/i,
  /STOP ?\*\d/i,
  /sender name KCB/i,
  /select Loans\s+(?:and\s+)?Savings/i,
  /Dial \*\d+#/i,

  // Loan paperwork: the facility, its fee, its due date, its balance. The money
  // itself moves through the wallet and is recorded there.
  /facility fee/i,
  /has been processed and sent to your/i,
  /has a balance of KES [\d,.]+ which is due/i,
  /savings Account to M-?PESA/i,
];

/**
 * A lender saying a loan is finished.
 *
 * Nothing moves, so there is no transaction to make — but it is the only thing
 * that can tell the difference between "he pays this every month" and "he paid
 * this every month until it was done", and those predict opposite futures.
 */
const SETTLED_RE = /(?:has (?:now )?been|is now) fully paid/i;

/**
 * Who said it. The sentence naming the lender and the sentence saying it is
 * finished are usually two sentences apart - "your payment of KES X to KCB
 * Mobile Loan has been received for loan N. The loan has now been fully paid."
 * - so they are matched separately rather than in one reach.
 */
const SETTLED_LENDER = [
  /to\s+([A-Za-z][A-Za-z0-9 .&-]{0,30}?)\s+(?:Mobile\s+|M-?PESA\s+)?[Ll]oan/i,
  /your\s+([A-Za-z][A-Za-z0-9 .&-]{0,30}?)\s+(?:Mobile\s+|M-?PESA\s+)?[Ll]oan/i,
];

/*
 * What a lender says about a loan, as distinct from money moving.
 *
 * These messages were all on the ignore list, rightly, as transactions: the
 * money they describe either moved through the wallet (and was recorded
 * there) or never moved at all. But they carry what no wallet row does - the
 * fee that was charged, the figure the lender wants back, and the day it
 * wants it - and a "fully paid" that closes the account. Read as NOTICES they
 * become a ledger; see js/loans.js. Account and loan numbers in the wording
 * are deliberately not captured.
 */
const KES = String.raw`(?:KES|Kshs?\.?)\s?`;
const SUM = (name) => String.raw`${KES}(?<${name}>[\d,]+(?:\.\d{1,2})?)`;
const DMY = (name) => String.raw`(?<${name}>\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})`;
const NOTICE_SHAPES = [
  {
    // "your loan of KES 1,120.00 has been processed and sent to your KCB
    // M-PESA Account with a facility fee of KES 527.85 charged. ... Your
    // repayment of KES 6,597.85 is due on 05/12/2026."
    kind: 'drawn',
    re: new RegExp(
      `loan of ${SUM('principal')} has been processed and (?:sent|credited) to your (?<lender>KCB M-?PESA|KCB) Account` +
        `(?:[^.]*?facility fee of ${SUM('fee')})?` +
        `(?:[^]*?repayment of ${SUM('due')} is due (?:on|by) ${DMY('date')})?`,
      'i',
    ),
  },
  {
    // "Your M-Shwari loan has been approved ... Ksh1,970.00 ... Facility fee
    // Ksh148.00 ... Repay Ksh2,118.00 by 23/4/24"
    kind: 'drawn',
    re: new RegExp(
      `Your (?<lender>M-?Shwari) loan has been approved[^]*?${SUM('principal')}` +
        `(?:[^]*?[Ff]acility fee (?:of )?${SUM('fee')})?` +
        `(?:[^]*?[Rr]epay ${SUM('due')} by ${DMY('date')})?`,
      'i',
    ),
  },
  {
    // A reminder: "Your repayment of KES 6,597.85 is due on 05/12/2026",
    // "balance of KES 8,170.00 is due on 01/12/2026", "outstanding ... due on".
    kind: 'due',
    re: new RegExp(
      `(?:loan|repayment|balance|outstanding(?: loan)?(?: balance)?) of ${SUM('due')} is due (?:on|by) ${DMY('date')}`,
      'i',
    ),
  },
  {
    // The bank acknowledging a repayment it received, for a loan it holds.
    kind: 'repaid',
    re: new RegExp(
      `(?:MOBI LOAN REPAYMENT request of ${SUM('amount')}|payment of ${SUM('amount2')} (?:for|to) (?<lender>KCB Mobile Loan|VOOMA Loan|KCB M-?PESA)[^.]*?(?:has been )?received)`,
      'i',
    ),
    lender: 'KCB Mobile Loan',
  },
  {
    kind: 'repaid',
    re: new RegExp(`partially paid by ${SUM('amount')}`, 'i'),
  },
  {
    kind: 'cleared',
    re: SETTLED_RE,
  },
];

/** The lender a notice is about: named in it, or else whoever sent it. */
function noticeLender(body, groups, fallback) {
  if (groups && groups.lender) return groups.lender;
  if (/m-?shwari/i.test(body)) return 'M-Shwari';
  if (/kcb\s*m-?pesa/i.test(body)) return 'KCB M-PESA';
  if (/kcb|mobi\s*loan/i.test(body)) return 'KCB Mobile Loan';
  if (/fuliza/i.test(body)) return 'Fuliza';
  if (/ncba/i.test(body)) return 'NCBA';
  const named = SETTLED_LENDER.map((re) => body.match(re)).find(Boolean);
  if (named) return named[1];
  return fallback || '';
}

const noticeSum = (v) => (v == null ? null : Number(String(v).replace(/,/g, '')) || null);
function dmyToIso(v) {
  const m = String(v || '').match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

/** Every notice in one message, each stamped with the message's own time. */
function loanNotices(body, at, sender) {
  const out = [];
  for (const shape of NOTICE_SHAPES) {
    const m = body.match(shape.re);
    if (!m) continue;
    const g = m.groups || {};
    const lender = noticeLender(body, { lender: g.lender || shape.lender }, sender);
    if (!lender) continue;
    const n = { kind: shape.kind, lender, at: at || '' };
    if (shape.kind === 'drawn') {
      n.principal = noticeSum(g.principal);
      n.fee = noticeSum(g.fee);
      n.due = noticeSum(g.due);
      n.dueDate = dmyToIso(g.date);
    } else if (shape.kind === 'due') {
      n.due = noticeSum(g.due);
      n.dueDate = dmyToIso(g.date);
    } else if (shape.kind === 'repaid') {
      n.amount = noticeSum(g.amount || g.amount2);
    }
    out.push(n);
  }
  // A draw that states its repayment already says what is due; the separate
  // reminder shape would say it a second time.
  return out.some((n) => n.kind === 'drawn' && n.due) ? out.filter((n) => n.kind !== 'due') : out;
}

/** The first word of a lender's name, which is the part that identifies it. */
function lenderKey(name) {
  const w = String(name || '').trim().split(/\s+/)[0] || '';
  return w.length >= 3 ? w.toUpperCase() : '';
}

/**
 * @param {string} raw one or more M-PESA SMS messages
 * @returns {{transactions: object[], unparsed: string[], ignored: number, settled: object[], notices: object[]}}
 */
export function parseMessages(raw) {
  const transactions = [];
  const unparsed = [];
  const settled = [];
  const notices = [];
  let ignored = 0;
  // Messages arrive oldest first. A dateless message (a Fuliza repayment) happens
  // within seconds of the transaction that triggered it, so the previous one's
  // date is a far better answer than nothing — and when the phone hands over the
  // message's own timestamp, that is used instead and this never comes up.
  let lastDate = null;

  for (const block of splitMessages(raw)) {
    const { body, at, account } = stripStamp(block);
    // The echo test runs FIRST for a bank. It is not a fallback for a message
    // that would not parse — it is the thing that decides whether a message is
    // a record of money or a repetition of one.
    if (SETTLED_RE.test(body)) {
      const named = SETTLED_LENDER.map((re) => body.match(re)).find(Boolean);
      const key = lenderKey(named && named[1]);
      if (key) settled.push({ lender: key, date: (at || lastDate || '').slice(0, 10) });
    }
    // Read before the ignore list gets its say: the notices live on it.
    notices.push(...loanNotices(body, at || lastDate, senderOf(block)));

    const echo = account && BANK_ECHOES.some((re) => re.test(body));
    const txns = account
      ? echo
        ? []
        : parseBank(body, account, at)
      : parseOne(body, at || lastDate);
    if (txns.length) {
      transactions.push(...txns);
      lastDate = txns[0].date || lastDate;
    } else if (echo || NOT_A_TRANSACTION.some((re) => re.test(body))) {
      ignored++;
    } else {
      unparsed.push(body);
    }
  }
  return { transactions, unparsed, ignored, settled, notices };
}

/** The sender's name off the phone's stamp, for a notice that names nobody. */
function senderOf(block) {
  const m = block.match(STAMP_RE);
  return m && m[2] ? m[2].trim() : '';
}

// The app wraps each message the phone hands over in its own timestamp and the
// name it came from: several M-PESA messages carry no date of their own, and a
// bank's message has to be filed against the bank's account rather than the
// wallet's.
const STAMP_RE = /^#at (\d+)(?:[^\S\n]+([^\n]*))?\n?/;

/** Which account a sender's messages belong to; absent means the wallet. */
const ACCOUNTS = {
  KCB: 'kcb',
  'KCB M-PESA': 'kcb',
  STANCHART: 'stanchart',
};

function stripStamp(block) {
  const m = block.match(STAMP_RE);
  if (!m) return { body: block, at: null, account: null };
  const sender = (m[2] || '').trim().toUpperCase();
  return {
    body: block.slice(m[0].length).trim(),
    at: new Date(Number(m[1])).toISOString(),
    // "KCB M-PESA" is a loan product rather than the bank's own account, but
    // it is still KCB talking: its messages are loan paperwork and offers, and
    // the money itself moves through the wallet, which records it. Left
    // unmapped, every one of them was read as if M-PESA had sent it and landed
    // in the not-recognised pile - 100 of the last 136.
    account: ACCOUNTS[sender] || null,
  };
}

// Messages get pasted run-together. A receipt code followed by "Confirmed" reliably
// marks the start of a new one, so split there rather than on newlines. When the
// phone supplies them they arrive stamped, one per message, and that boundary is
// exact — so it wins.
function splitMessages(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  if (/^#at \d+/m.test(text)) {
    // The stamp carries the sender after the timestamp, so the lookahead cannot
    // insist on a newline straight after the digits. When it did, nothing split
    // at all and a whole batch arrived as one block.
    return text.split(/\n(?=#at \d+(?:[^\S\n][^\n]*)?\n)/).map((s) => s.trim()).filter(Boolean);
  }

  const starts = [];
  const re = /\b[A-Z0-9]{10}\s+[Cc]onfirmed/g;
  let m;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  if (!starts.length) return text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  const blocks = [];
  if (starts[0] > 0) {
    const pre = text.slice(0, starts[0]).trim();
    if (pre) blocks.push(pre);
  }
  for (let i = 0; i < starts.length; i++) {
    blocks.push(text.slice(starts[i], starts[i + 1] ?? text.length).trim());
  }
  return blocks.filter(Boolean);
}


/**
 * A bank writes the date four different ways, sometimes two of them in one
 * message. Whichever it used, it beats the message's own arrival time.
 */
function bankDate(g) {
  if (g.ymd) return parseDateTime(g.ymd.split('-').reverse().join('/'), g.ymdt || '');
  if (g.iso) return `${g.iso}T12:00:00.000Z`;
  if (g.dmy) {
    const [d, m, y] = g.dmy.split('-');
    return parseDateTime(`${d}/${m}/${y}`, '');
  }
  if (g.d) return parseDateTime(g.d, g.t || '');
  return null;
}

/** One message from a bank, filed against that bank's account. */
function parseBank(block, account, at) {
  for (const p of BANK_PATTERNS) {
    const m = block.match(p.re);
    if (!m) continue;
    const g = m.groups;
    const date = bankDate(g) || at;
    if (!date) return [];
    // A bank message carries no receipt, so the id is built from what makes it
    // unique: the account, the moment, and the amount.
    const id = `${account}-${date.slice(0, 19)}-${g.amt.replace(/,/g, '')}`;
    const txn = {
      id,
      receipt: null,
      date,
      amount: money(g.amt),
      direction: p.direction,
      type: p.type,
      counterparty: clean(g.who) || p.who || p.type,
      account: g.acct ? `ending ${g.acct}` : g.card ? `card ${g.card}` : null,
      balance: null,
      accountSource: account,
      source: 'sms',
    };
    if (p.after) p.after(txn, g);
    return [txn];
  }
  return [];
}

function parseOne(block, fallbackDate = null) {
  const out = [];

  for (const p of PATTERNS) {
    const m = block.match(p.re);
    if (!m) continue;
    const g = m.groups;

    const receipt = g.rcpt.toUpperCase();
    const date = parseDateTime(g.d, g.t) || fallbackDate;
    let counterparty = clean(g.who) || p.who || p.type;
    if (g.who && p.whoPrefix) counterparty = p.whoPrefix + clean(g.who);

    const txn = {
      id: receipt,
      receipt,
      date,
      amount: money(g.amt),
      direction: p.direction,
      type: p.type,
      counterparty,
      account: g.acct ? clean(g.acct) : null,
      balance: matchBalance(block),
      source: 'sms',
    };
    if (p.after) p.after(txn, g);
    out.push(txn);

    // The transaction cost is a real, separate outflow. M-PESA reports it inside the
    // parent message, so it shares the receipt code — suffix it to keep ids unique.
    const cost = block.match(new RegExp(`Transaction cost,?\\s*${CUR}(${NUM})`, 'i'));
    if (cost && money(cost[1]) > 0) {
      out.push({
        id: `${receipt}-COST`,
        receipt,
        date: txn.date,
        amount: money(cost[1]),
        direction: 'Out',
        type: 'Charge',
        counterparty: 'M-PESA Charge',
        account: null,
        balance: null,
        source: 'sms',
      });
    }
    break;
  }

  // A Fuliza overdraft can accompany another transaction, so it is not an else-branch.
  const f = block.match(FULIZA_RE);
  if (f && !out.some((t) => t.type === 'Fuliza')) {
    const anchor = out[0];
    out.push({
      id: `${f.groups.rcpt.toUpperCase()}-FULIZA`,
      receipt: f.groups.rcpt.toUpperCase(),
      date: anchor ? anchor.date : fallbackDate,
      amount: money(f.groups.amt),
      // A draw is money arriving in the wallet to cover a shortfall, so its
      // direction is In — the same convention the statement importer uses for
      // "OverDraft of Credit Party". It was 'Out' here, which meant every draw
      // read from an SMS was replayed by the Fuliza panel as a REPAYMENT and the
      // outstanding balance came out too low. rules.js files it as credit, so it
      // never reaches the income figure.
      direction: 'In',
      type: 'Fuliza',
      counterparty: 'Fuliza M-PESA',
      account: null,
      balance: null,
      source: 'sms',
    });
  }

  // A transaction with no date at all cannot be placed on any chart or in any
  // month, so it is honest to report it as unread rather than file it under today.
  if (out.length && !out[0].date) return [];

  return out;
}

function matchBalance(block) {
  const b = block.match(new RegExp(`${BAL} ${CUR}(${NUM})`, 'i'));
  return b ? money(b[1]) : null;
}

/**
 * Groups messages the parser could not read by SHAPE, so a few hundred failures
 * read as a handful of lines instead of a wall of text. Receipt codes, amounts and
 * numbers are the part that varies; what is left is the sentence Safaricom used,
 * which is the only thing worth looking at when deciding what to teach it next.
 */
export function groupUnparsed(list) {
  const groups = new Map();
  for (const text of list) {
    // What varies between two messages of the same shape is the receipt, the
    // amounts, the numbers and the SHOUTED name of whoever was paid — M-PESA
    // prints merchants and people in capitals. Strip all four and what is left is
    // the sentence Safaricom wrote, which is the thing worth reading.
    const key = String(text)
      .replace(/\b[A-Z0-9]{10}\b/g, '')
      .replace(/(?:Ksh|KES)\s?[\d,]+(?:\.\d{1,2})?/gi, '#')
      .replace(/\b[\d][\d,.\/:]*\b/g, '#')
      .replace(/\b[A-Z][A-Z'&.\-]+\b/g, '')
      .replace(/[#\s]+/g, ' ')
      .trim()
      .slice(0, 110);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, sample: text });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export const _internals = { splitMessages, parseDateTime, parseOne };
