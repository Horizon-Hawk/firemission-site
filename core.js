/* FIRE Mission core — read bank / card / brokerage exports, merge them, find transfers, income,
   subscriptions, duplicate charges and fees. Pure functions, no network, no DOM.
   Runs in the browser (window.FireMission) and in any JS engine. Nothing is stored. */
(function (root) {
  'use strict';

  // ---------- categories ----------
  const CATEGORIES = [
    'Groceries', 'Dining out', 'Shopping', 'Auto & gas', 'Housing', 'Loans', 'Utilities & phone', 'Insurance',
    'Health', 'Personal care', 'Kids & family', 'Entertainment', 'Subscriptions', 'Travel', 'Home & yard',
    'Education', 'Gifts & giving', 'People (Venmo/Zelle/Cash App)', 'Buy now, pay later', 'Fees & interest',
    'Taxes', 'Cash & ATM', 'Checks', 'Card payments (card not loaded)', 'Other',
  ];

  // what the person answers for a deposit we can't place, and what it counts as
  const PAYER_CHOICES = {
    paycheck: { label: 'Paycheck', counts: 'income' },
    side: { label: 'Side income', counts: 'income' },
    rental: { label: 'Rental income', counts: 'income' },
    pension: { label: 'Pension / retired pay', counts: 'income' },
    benefit: { label: 'Benefits (VA, Social Security…)', counts: 'income' },
    interest: { label: 'Interest / dividends', counts: 'income' },
    other_income: { label: 'Other income', counts: 'income' },
    own: { label: 'From my own account', counts: 'internal' },
    refund: { label: 'Refund / reimbursement', counts: 'offset' },
    investment: { label: 'Taken out of investments', counts: 'withdrawal' },
    ignore: { label: 'Ignore it', counts: 'ignore' },
  };
  // ... and for money sent somewhere we can't see
  const OUT_CHOICES = {
    loan: { label: 'Loan payment', counts: 'spend', category: 'Loans' },
    housing: { label: 'Mortgage / rent', counts: 'spend', category: 'Housing' },
    saving: { label: 'Savings / investing', counts: 'saving' },
    own: { label: 'To my own account', counts: 'internal' },
    people: { label: 'Paying a person', counts: 'spend', category: 'People (Venmo/Zelle/Cash App)' },
    bill: { label: 'A bill or purchase', counts: 'spend', category: 'Other' },
    ignore: { label: 'Ignore it', counts: 'ignore' },
  };

  // ---------- low-level parsing ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
    const delim = (sample.match(/\t/g) || []).length > (sample.match(/,/g) || []).length ? '\t'
      : (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');
  function ymd(y, m, d) {
    y = +y; m = +m; d = +d;
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  function toDate(s) {
    s = String(s == null ? '' : s).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(m[1], m[2], m[3]);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return ymd(m[1], m[2], m[3]);
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) return ymd(m[3].length === 2 ? '20' + m[3] : m[3], m[1], m[2]);
    if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) return ymd(m[3], MONTHS[m[1].toLowerCase()], m[2]);
    if ((m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{2,4})/))) return ymd(m[3].length === 2 ? '20' + m[3] : m[3], MONTHS[m[2].toLowerCase()], m[1]);
    return null;
  }
  function money(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[$,\s]/g, '').replace(/USD/i, '');
    if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
    const n = parseFloat(s);
    if (!isFinite(n)) return null;
    return Math.round((neg ? -n : n) * 100) / 100;
  }
  const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
  const r2 = n => Math.round(n * 100) / 100;

  // ---------- text cleanup ----------
  const ALIASES = [
    [/AMAZON DIGIT|AMZN DIGITAL|KINDLE/, 'Amazon Digital'], [/AMZN|AMAZON(?! PRIME)/, 'Amazon'], [/AMAZON PRIME|PRIME VIDEO/, 'Amazon Prime'], [/COSTCO GAS/, 'Costco Gas'],
    [/COSTCO/, 'Costco'], [/WAL-?MART|WM SUPERCENTER|WALMART/, 'Walmart'], [/\bTARGET\b/, 'Target'],
    [/MCDONALD/, "McDonald's"], [/STARBUCKS/, 'Starbucks'], [/DUTCH BROS/, 'Dutch Bros'], [/DOORDASH/, 'DoorDash'],
    [/UBER\s*\*?\s*EATS/, 'Uber Eats'], [/\bUBER\b/, 'Uber'], [/\bLYFT\b/, 'Lyft'], [/NETFLIX/, 'Netflix'],
    [/SPOTIFY/, 'Spotify'], [/HULU/, 'Hulu'], [/DISNEY ?PLUS|DISNEYPLUS/, 'Disney+'], [/YOUTUBE/, 'YouTube'],
    [/APPLE\.COM\/BILL|APPLE\.COM BILL/, 'Apple (App Store / iCloud)'], [/HOME DEPOT|HOMEDEPOT/, 'Home Depot'],
    [/LOWE'?S\b/, "Lowe's"], [/CHEVRON/, 'Chevron'], [/SHELL OIL|\bSHELL\b/, 'Shell'], [/WENDY'?S/, "Wendy's"],
    [/TACO BELL/, 'Taco Bell'], [/CHICK-?FIL-?A/, 'Chick-fil-A'], [/365 MARKET/, '365 Market'],
    [/FRED[- ]?MEYER/, 'Fred Meyer'], [/SAFEWAY/, 'Safeway'], [/WINCO/, 'WinCo'], [/TRADER JOE/, "Trader Joe's"],
    [/CAPITAL ONE/, 'Capital One'], [/OPENAI|CHATGPT/, 'OpenAI'], [/ANTHROPIC|CLAUDE\.AI/, 'Anthropic'],
  ];
  function cleanDesc(s) {
    let t = String(s || '').toUpperCase();
    t = t.replace(/\*{2,}\S*/g, ' ')
      .replace(/\b(WEB|PPD|CCD|TEL) ID:?\s*\S+/g, ' ')
      .replace(/^(POS|ACH|DEBIT CARD|DEBIT|CHECKCARD|CHECK CARD|PURCHASE AUTHORIZED ON \S+|PURCHASE|RECURRING PAYMENT|PREAUTHORIZED)\s+/, '')
      .replace(/^(SQ|TST|SP|DD|PP|IN|PY|BT|CKE|SPO|FS|EB|LS|PAR|SMP|PAYPAL|GOOGLE)\s?\*\s?/, '')
      .replace(/#\s?\S*/g, ' ')
      .replace(/\b\d{3,}\b/g, ' ')
      .replace(/\b\d{3}-\d{3}-\d{4}\b/g, ' ')
      .replace(/\s+[A-Z]{2}$/, '')
      .replace(/[*]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return t || String(s || '').toUpperCase().trim();
  }
  const titleCase = s => s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/'S\b/g, "'s");
  // grouping key + display name for a merchant or payer
  function merchantOf(raw) {
    const up = String(raw || '').toUpperCase();
    for (const [re, name] of ALIASES) if (re.test(up)) return { key: name.toUpperCase(), name };
    const c = cleanDesc(raw);
    const key = c.split(' ').filter(w => w.length > 1 || /\d/.test(w)).slice(0, 3).join(' ') || c;
    return { key, name: titleCase(c.split(' ').slice(0, 4).join(' ')) };
  }

  // ---------- file reading ----------
  const H = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  const DATE_COLS = ['transaction date', 'activity date', 'trans. date', 'trans date', 'date', 'posted date', 'posting date', 'post date', 'settlement date', 'run date'];
  const DESC_COLS = ['description', 'payee', 'merchant', 'merchant name', 'transaction description', 'details', 'memo', 'name', 'action'];
  const AMT_COLS = ['amount', 'amount usd', 'transaction amount', 'amount usd.', 'net amount'];
  const DEBIT_COLS = ['debit', 'debits', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'charges'];
  const CREDIT_COLS = ['credit', 'credits', 'deposit', 'deposits', 'deposit amount', 'money in', 'payments'];
  const CARD_COLS = ['card no.', 'card no', 'card', 'card number', 'card member', 'account number'];
  const OWNER_COLS = ['name', 'cardholder', 'card member', 'card holder'];
  const CAT_COLS = ['category', 'transaction category', 'type'];
  const find = (hdr, names) => { for (const n of names) { const i = hdr.indexOf(n); if (i >= 0) return i; } return -1; };

  function accountBase(fileName) {
    return String(fileName || 'Account').replace(/\.[a-z0-9]+$/i, '')
      .replace(/\d{4}-\d{2}-\d{2}(T[\d_:.]+)?/g, ' ').replace(/\b\d{4}\s*-\s*\d{4}\b/g, ' ')
      .replace(/\b(to|transactions?|export|statement|activity|download|history)\b/gi, ' ')
      .replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Account';
  }
  const ISSUERS = [
    ['capitalone', /capital\s?one/i], ['citi', /\bciti|costco visa/i], ['chase', /chase/i], ['amex', /amex|american express/i],
    ['discover', /discover/i], ['robinhood', /robinhood/i], ['usaa', /usaa/i], ['wells', /wells fargo/i],
    ['bofa', /bank of america|bofa/i], ['apple', /apple card/i], ['barclays', /barclay/i], ['synchrony', /synchrony/i],
  ];
  const issuerOf = s => { for (const [k, re] of ISSUERS) if (re.test(s)) return k; return ''; };

  // header row: first row in the top 15 with a date column and an amount (or debit/credit) column
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const h = rows[i].map(H);
      if (find(h, DATE_COLS) >= 0 && (find(h, AMT_COLS) >= 0 || (find(h, DEBIT_COLS) >= 0 && find(h, CREDIT_COLS) >= 0))) return i;
    }
    return -1;
  }

  /* Read one file. Returns { format, txns, warnings } or { needsMapping, headers, sample } when the
     columns can't be recognised (the page then asks once which column is which). */
  function parseFile(fileName, text, mapping) {
    text = String(text || '');
    if (/<OFX|OFXHEADER/i.test(text)) return parseOFX(fileName, text);
    const rows = parseCSV(text);
    let hi = mapping ? mapping.headerRow || 0 : findHeader(rows);
    if (hi < 0) return { needsMapping: true, fileName, headers: rows[0] || [], sample: rows.slice(1, 6) };
    const hdr = rows[hi].map(H);
    // this page's own "Save as CSV" export: reading it back would count every transaction twice
    if (hdr.includes('counts as') && hdr.includes('merchant payer') && hdr.includes('income source'))
      return { kind: 'unsupported', ownExport: true, fileName, txns: [], warnings: ['This is a FIRE Mission export, so it is left out (reading it back would count everything twice). Load the original bank and card files instead.'] };
    if (!mapping && hdr.includes('trans code') && hdr.includes('instrument')) return parseBrokerage(fileName, rows, hi, hdr);
    const col = mapping ? {
      date: mapping.date, desc: [mapping.desc], amount: mapping.amount ?? -1, debit: mapping.debit ?? -1, credit: mapping.credit ?? -1,
      card: -1, owner: -1, cat: -1, raw: -1, type: -1,
    } : {
      date: find(hdr, DATE_COLS),
      desc: DESC_COLS.map(n => hdr.indexOf(n)).filter(i => i >= 0),
      amount: find(hdr, AMT_COLS), debit: find(hdr, DEBIT_COLS), credit: find(hdr, CREDIT_COLS),
      card: find(hdr, CARD_COLS), owner: find(hdr, OWNER_COLS), cat: find(hdr, ['category', 'transaction category']),
      raw: find(hdr, ['original description']), type: find(hdr, ['type', 'transaction type']),
    };
    if (col.owner === col.card) col.owner = -1;
    if (col.desc.length > 1) col.desc = col.desc.filter(i => i !== col.owner || col.desc.length === 1);
    const base = accountBase(fileName);
    const issuer = issuerOf(fileName) || issuerOf(rows.slice(0, hi + 1).join(' '));
    const out = [], warnings = [];
    let bad = 0;
    for (const r of rows.slice(hi + 1)) {
      const date = toDate(r[col.date]);
      if (!date) { bad++; continue; }
      let amt;
      if (col.debit >= 0 && col.credit >= 0 && (col.amount < 0 || (r[col.amount] || '').trim() === '')) {
        const d = money(r[col.debit]), c = money(r[col.credit]);
        if (d == null && c == null) { bad++; continue; }
        amt = Math.abs(c || 0) - Math.abs(d || 0);
      } else {
        amt = money(r[col.amount]);
        if (amt == null) { bad++; continue; }
        const ty = col.type >= 0 ? String(r[col.type]).toUpperCase() : '';
        if (/^(DEBIT|DR)$/.test(ty)) amt = -Math.abs(amt);
        else if (/^(CREDIT|CR)$/.test(ty)) amt = Math.abs(amt);
      }
      const srcCat = col.cat >= 0 ? String(r[col.cat] || '').trim() : '';
      let desc = '';
      for (const i of col.desc) { if (String(r[i] || '').trim()) { desc = String(r[i]).trim(); break; } }
      const rawOrig = col.raw >= 0 ? String(r[col.raw] || '').trim() : '';
      if (rawOrig && (!desc || /pending/i.test(srcCat))) desc = rawOrig;
      const card = col.card >= 0 ? String(r[col.card] || '').replace(/\D/g, '').slice(-4) : '';
      const owner = col.owner >= 0 ? titleCase(String(r[col.owner] || '').trim()) : '';
      out.push({ date, amount: r2(amt), desc, raw: rawOrig || desc, srcCat, card, owner,
        type: col.type >= 0 ? String(r[col.type] || '') : '', file: fileName });
    }
    if (bad) warnings.push(`${bad} row${bad > 1 ? 's' : ''} without a readable date or amount were skipped`);
    // which way do the signs run? Card exports often show purchases as positive.
    const isCardFile = col.card >= 0 || /card|visa|mastercard|amex|discover/i.test(fileName);
    const pay = out.filter(t => /PAYMENT|THANK YOU|AUTOPAY|PYMT/i.test(t.desc));
    const pos = out.filter(t => t.amount > 0).length, neg = out.length - pos;
    let flipped = false;
    if (pos > neg * 2 && (pay.length ? pay.filter(t => t.amount < 0).length > pay.length / 2 : isCardFile)) {
      for (const t of out) t.amount = -t.amount;
      flipped = true;
    }
    const kind = isCardFile || flipped || (col.debit >= 0 && col.card >= 0) ? 'card' : 'bank';
    for (const t of out) {
      t.account = base + (t.card && col.card >= 0 ? ' ••' + t.card : '');
      t.accountType = kind;
      t.issuer = issuer;
    }
    return { format: col.debit >= 0 ? 'debit/credit columns' : 'amount column', flipped, txns: out, warnings, accountBase: base };
  }

  // ---------- investment accounts ----------
  // what a brokerage row is, from its transaction code (Robinhood activity report layout)
  function invKind(code, desc, amount) {
    code = String(code || '').toUpperCase().trim();
    const d = String(desc || '').toUpperCase();
    if (/^(ACH|RTP|XENT|XENT_CC|WIRE|DCF|INSTANT|DEP|WD)$/.test(code) || /^(ACH|INSTANT) (DEPOSIT|WITHDRAWAL)/.test(d)) return amount >= 0 ? 'deposit' : 'withdrawal';
    if (/^(ACATI|ACATO|ACATS|JNLC|JNLS|TRF|XFER)$/.test(code)) return 'moved';
    if (/^(CDIV|MDIV|DIV|QDIV|SDIV|DIVR|PDIV)$/.test(code)) return 'dividend';
    if (/^(INT|BINT|IINT|SLIP)$/.test(code)) return 'interest';
    if (code === 'MTCH') return 'match';
    if (/^(GOLD|DFEE|DTAX|AFEE|MINT|MRGN|ADRF|FEE|TAX|NRA|CFEE)$/.test(code) || (/\bFEE\b/.test(d) && amount < 0)) return 'fee';
    if (code === 'STO') return 'premium_in';
    if (code === 'BTC') return 'premium_out';
    return 'trade';
  }
  const INV_LABEL = { deposit: 'Deposit', withdrawal: 'Withdrawal', moved: 'Moved from another broker', dividend: 'Dividend', interest: 'Interest',
    match: 'Contribution match', fee: 'Investment fee', premium_in: 'Option sold', premium_out: 'Option bought back', trade: 'Trade' };

  function parseBrokerage(fileName, rows, hi, hdr) {
    const c = n => hdr.indexOf(n);
    const iDate = c('activity date'), iDesc = c('description'), iCode = c('trans code'), iAmt = c('amount'), iSym = c('instrument'), iQty = c('quantity');
    const broker = issuerOf(fileName) === 'robinhood' || hdr.includes('process date') ? 'Robinhood' : 'Brokerage';
    const out = [];
    let bad = 0;
    for (const r of rows.slice(hi + 1)) {
      const date = toDate(r[iDate]);
      if (!date) { if (String(r[iDate] || '').trim()) bad++; continue; }
      const code = String(r[iCode] || '').trim(), amt = money(r[iAmt]) || 0;
      const desc = String(r[iDesc] || '').split(/\r?\n/)[0].trim();
      const sym = String(r[iSym] || '').trim();
      out.push({ date, amount: amt, desc: (sym && !desc.toUpperCase().startsWith(sym) ? sym + ' · ' : '') + desc, raw: code + ' ' + desc + ' ' + (r[iQty] || ''),
        srcCat: code, card: '', owner: '', type: code, invKind: invKind(code, desc, amt), symbol: sym,
        file: fileName, account: broker + ' investing', accountType: 'invest', issuer: broker.toLowerCase() });
    }
    return { format: broker + ' activity report', kind: 'invest', broker, flipped: false, txns: out,
      warnings: bad ? [`${bad} rows without a readable date were skipped`] : [], accountBase: broker + ' investing' };
  }

  /* A monthly brokerage statement (PDF), given as the text of each page (lines joined with \n).
     Page 1 names the account and carries the balances; the rest is used to tie activity exports to it. */
  function parseStatement(fileName, pages) {
    const p1 = String(pages[0] || ''), all = pages.join('\n');
    if (/NET PAY/i.test(all) && /(Advice|Pay|Check) Date/i.test(all) && /EARNINGS/i.test(all)) return parsePayStub(fileName, pages);
    if (/Your Social Security Statement/i.test(all.slice(0, 600))) return parseSSA(fileName, all);
    if (/Wage and Tax/i.test(all) && /W-2/.test(all) && /Federal income tax withheld/i.test(all)) return parseW2(fileName, all);
    if (/RETIREE ACCOUNT STATEMENT/i.test(all.slice(0, 400))) return parseRAS(fileName, all);
    if (/LEAVE AND EARNINGS STATEMENT/i.test(all.slice(0, 400))) return parseLES(fileName, all);
    if (/Form 1098\b/i.test(all) && /Mortgage interest received/i.test(all)) return parse1098(fileName, all);
    if (/Form 1099-R/i.test(all) && /Gross Distribution/i.test(all)) return parse1099R(fileName, all);
    const per = p1.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:to|-|–|through)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const acc = p1.match(/([A-Za-z][A-Za-z ]{1,30}?)\s*Account\s*(?:#|Number|No\.?)\s*:?\s*([*xX•\d-]{4,})/);
    if (!acc) return parsePlanStatement(fileName, pages);
    if (!per) return null;
    const num = s => { const m = String(s || '').match(/\(?-?\$?\s*[\d,]+\.\d{2}\)?/); return m ? money(m[0].replace(/\s/g, '')) : null; };
    const two = label => { const m = p1.match(new RegExp(label + '\\s+(\\(?-?\\$?[\\d,]+\\.\\d{2}\\)?)\\s+(\\(?-?\\$?[\\d,]+\\.\\d{2}\\)?)', 'i')); return m ? [money(m[1]), money(m[2])] : [null, null]; };
    const broker = /robinhood/i.test(all.slice(0, 4000)) ? 'Robinhood' : /schwab/i.test(all.slice(0, 4000)) ? 'Schwab' : /fidelity/i.test(all.slice(0, 4000)) ? 'Fidelity' : 'Brokerage';
    const type = acc[1].trim().replace(/^.*\b(Roth IRA|Traditional IRA|SEP IRA|Rollover IRA|Individual|Joint|Custodial|UTMA|UGMA|Trust|Margin|Cash)\b.*$/i, '$1');
    const digits = acc[2].replace(/\D/g, '');
    const [openV, closeV] = two('Portfolio Value'), [openC, closeC] = two('Net Account Balance');
    const [divP] = two('Dividends'), [intP] = two('Interest Earned'), [contP, contY] = two('Contributions');
    return {
      kind: 'statement', format: broker + ' monthly statement', broker, fileName, accountType: type, last4: digits.slice(-4),
      start: toDate(per[1]), end: toDate(per[2]), open: openV, close: closeV, cashOpen: openC, cashClose: closeC,
      dividends: divP, interest: intP, contributions: contP, contributionsYTD: contY, text: all, txns: [], warnings: [],
      account: `${broker} ${type} ••${digits.slice(-4)}`,
    };
  }

  /* A pay stub (PeopleSoft "pay advice" and similar): gross, taxes, what came out before and after tax, what the
     employer paid in, net pay and where it was deposited, for this check and year to date. The deduction tables sit
     side by side, so their columns are split by word position (pages.rows) when the page passes it. */
  const payKind = n => /stock purchase|\bESPP\b/i.test(n) ? 'stock' : /401\(?k|403\(?b|\b457\b|\bTSP\b|thrift|retire|pension|deferred comp/i.test(n) ? 'retire'
    : /\bHSA\b|health savings/i.test(n) ? 'hsa' : 'other';
  function parsePayStub(fileName, pages) {
    const all = pages.join('\n'), NUM = '(-?[\\d,]+\\.\\d{2})';
    const date = re => { const m = all.match(re); return m ? toDate(m[1]) : null; };
    const payDate = date(/(?:Advice|Pay|Check) Date:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const begin = date(/(?:Pay )?(?:Period )?Begin(?:ning)? Date:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i), end = date(/(?:Pay )?(?:Period )?End(?:ing)? Date:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const line = (cells, kind) => { const m = cells.trim().match(new RegExp('^(.*?[A-Za-z)].*?)\\s+' + NUM + '\\s+' + NUM + '$')); return m && !/^TOTAL/i.test(m[1]) ? { name: m[1].trim(), current: money(m[2]), ytd: money(m[3]), kind: kind || payKind(m[1]) } : null; };
    const totalsRow = label => { const m = all.match(new RegExp('^' + label + '\\s+' + NUM + '\\s+' + NUM + '\\s+' + NUM + '\\s+' + NUM + '\\s+' + NUM, 'mi')); return m ? m.slice(1, 6).map(money) : null; };
    let cur = totalsRow('Current'), ytd = totalsRow('YTD');
    const pick = (re, i) => { const m = all.match(re); return m ? money(m[i]) : null; };
    const T = r => r && { gross: r[0], taxable: r[1], taxes: r[2], deductions: r[3], net: r[4] };
    let current = T(cur), toDateV = T(ytd);
    if (!current) { // other layouts: labelled rows with this-period and year-to-date amounts
      const g = new RegExp('Gross Pay\\s+' + NUM + '\\s+' + NUM, 'i'), n = new RegExp('Net Pay\\s+' + NUM + '\\s+' + NUM, 'i');
      if (pick(g, 1) == null || pick(n, 1) == null) return null;
      current = { gross: pick(g, 1), net: pick(n, 1) }; toDateV = { gross: pick(g, 2), net: pick(n, 2) };
    }
    const taxes = [], before = [], after = [], employer = [];
    const rows = (pages.rows || [])[0];
    if (rows) {
      const text = items => items.map(i => i.s).join(' ');
      const at = re => { for (const r of rows) for (const it of r.items) if (re.test(it.s)) return { r, x: it.x }; return null; };
      const earnHead = at(/HOURS AND EARNINGS|^EARNINGS/i), taxHead = at(/^TAXES$/i), worked = at(/TOTAL HOURS WORKED/i);
      const bHead = at(/BEFORE-TAX DEDUCTIONS/i), aHead = at(/AFTER-TAX DEDUCTIONS/i), eHead = at(/EMPLOYER PAID/i), totHead = at(/^TOTAL GROSS/i);
      const between = (h, stop) => { const i = rows.indexOf(h.r), j = stop ? rows.indexOf(stop.r) : rows.length; return rows.slice(i + 1, j > i ? j : rows.length); };
      // section titles are centred over their columns; the "Description" headings under them mark where each column starts
      const descXs = h => {
        for (const r of rows.slice(rows.indexOf(h.r) + 1, rows.indexOf(h.r) + 4)) {
          const xs = r.items.filter(i => /^Description$/i.test(i.s.trim())).map(i => i.x);
          if (xs.length) return xs;
        }
        return [];
      };
      if (earnHead && taxHead) {
        const dx = descXs(earnHead).filter(x => x <= taxHead.x), tx = dx.length > 1 ? dx[dx.length - 1] : taxHead.x;
        for (const r of between(earnHead, worked || bHead).slice(1)) {
          const t = line(text(r.items.filter(i => i.x >= tx - 4)), 'tax'); if (t) taxes.push(t);
        }
      }
      if (bHead) {
        const dx = descXs(bHead);
        const xs = dx.length >= 2 ? dx.concat(dx.length === 2 ? [Infinity] : []) : [bHead.x, aHead ? aHead.x : Infinity, eHead ? eHead.x : Infinity];
        for (const r of between(bHead, totHead)) {
          const col = k => text(r.items.filter(i => i.x >= xs[k] - 4 && i.x < (xs[k + 1] || Infinity) - 4));
          const b = line(col(0)), a = line(col(1)), e = line(col(2));
          if (b) before.push(b); if (a) after.push(a); if (e) employer.push(e);
        }
      }
    }
    const deposits = [...all.matchAll(/(Checking|Savings)\s+[*xX•]+(\d{4})\s+([\d,]+\.\d{2})/gi)].map(m => ({ type: m[1], last4: m[2], amount: money(m[3]) }));
    const first = String(pages[0] || '').split('\n')[0] || '';
    const name = first.split(/\s+(?:Pay Group|Pay Begin|Division|Company|Advice|Check)\b/i)[0].replace(/,?\s*(Inc|LLC|Corp|Co)\.?$/i, '').trim() || 'Employer';
    // federal W-4 settings printed in the tax data box (first value after each label is the federal one)
    const w4v = re => (all.match(re) || [])[1];
    const w4 = { status: w4v(/Tax Status:\s*([A-Za-z ]+?)(?:\s+N\/A|\s{2,}|\n|$)/), extra: money(w4v(/Additional Amount:\s*([\d,]+\.\d{2})/) || '') ,
      dependents: money(w4v(/Dependent Amount:\s*([\d,]+\.\d{2})/) || ''), multipleJobs: w4v(/(?:Multiple Jobs|Spouse Works):?\s*([YN])\b/) };
    return { kind: 'paystub', format: 'pay stub', fileName, employer: name, payDate: payDate || end, begin, end: end || payDate, w4,
      current, ytd: toDateV, taxes, before, after, employerPaid: employer, deposits, txns: [], warnings: [] };
  }

  /* Form W-2. Box labels are fixed by the IRS; payroll printouts put each pair of labels on one line and the two
     amounts on the next (ADP), or the amount right after its label. Only the first (employee) copy is read; names,
     addresses and SSNs are never kept. */
  const W2CODES = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y', 'Z', 'AA', 'BB', 'DD', 'EE', 'FF', 'GG', 'HH', 'II']);
  function parseW2(fileName, all) {
    const N = '([\\d,]+\\.\\d{2})';
    const pair = (a, b) => { const m = all.match(new RegExp(a + '[^\\n]*?' + b + '[^\\n]*\\n\\s*' + N + '\\s+' + N, 'i')); return m ? [money(m[1]), money(m[2])] : null; };
    const one = label => { const m = all.match(new RegExp(label + '[^\\d\\n]{0,40}' + N, 'i')); return m ? money(m[1]) : null; };
    const b12 = pair('Wages, tips, other comp', 'Federal income tax withheld') || [one('Wages, tips, other comp'), one('Federal income tax withheld')];
    const b34 = pair('Social security wages', 'Social security tax withheld') || [one('Social security wages'), one('Social security tax withheld')];
    const b56 = pair('Medicare wages and tips', 'Medicare tax withheld') || [one('Medicare wages and tips'), one('Medicare tax withheld')];
    if (b12[0] == null) return null;
    const year = +((all.match(/W-2 Statement\s*(\d{4})/i) || all.match(/(\d{4})\s*W-2/) || all.match(/Form W-2[^\n]*?(\d{4})/) || [])[1] || 0) || null;
    const emp = (all.match(/Employer.s name, address,? and ZIP code\s*\n\s*([^\n]+)/i) || [])[1];
    // first copy only: everything before the first repeat of the box 1 label
    const i1 = all.search(/1 Wages, tips, other comp/i), i2 = all.slice(i1 + 10).search(/1 Wages, tips, other comp/i);
    const copy = i2 > 0 ? all.slice(0, i1 + 10 + i2) : all;
    const box12 = [];
    for (const m of copy.matchAll(/(?:^|\s)([A-Z]{1,2})\s+([\d,]+\.\d{2})(?=\s|$)/gm)) if (W2CODES.has(m[1]) && !box12.some(x => x.code === m[1])) box12.push({ code: m[1], amount: money(m[2]) });
    const b14 = [...all.matchAll(/14 Other\s+([\d,]+\.\d{2})\s+([A-Z][A-Z &.\-]{1,30}?)(?=\s+12[a-d]|\s*\n|$)/g)].map(m => ({ label: m[2].trim(), amount: money(m[1]) })).filter((x, i, a) => a.findIndex(y => y.label === x.label) === i);
    const state = all.match(/\b([A-Z]{2})\s+[\w-]{4,}\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
    return { kind: 'w2', format: 'W-2', fileName, year, employer: emp ? emp.trim().replace(/\s+(INC|LLC|CORP|CO)\.?$/i, '') : 'Employer',
      wages: b12[0], fedWithheld: b12[1], ssWages: b34[0], ssTax: b34[1], medicareWages: b56[0], medicareTax: b56[1],
      box12, box14: b14, retirementPlan: /Ret\. plan[^\n]*\n\s*X/i.test(copy), state: state ? { state: state[1], wages: money(state[2]), tax: money(state[3]) } : null, txns: [], warnings: [] };
  }

  /* DFAS Retiree Account Statement (military retired pay, myPay): each pay item has an OLD and NEW column; NEW is
     what's paid now. Allotments are listed by type and payee (often insurance premiums). */
  function parseRAS(fileName, all) {
    const item = label => { const m = all.match(new RegExp(label + '\\s+([\\d,]*\\.\\d{2})\\s+([\\d,]*\\.\\d{2})', 'i')); return m ? money(m[2]) : null; };
    const ytd = label => { const m = all.match(new RegExp(label + ':\\s*([\\d,]*\\.\\d{2})', 'i')); return m ? money(m[1]) : null; };
    const gross = item('GROSS PAY'), taxable = item('TAXABLE INCOME'), net = item('NET PAY');
    if (gross == null || net == null) return null;
    const dateM = all.match(/([A-Z]{3} \d{1,2}, \d{4})\s+([A-Z]{3} \d{1,2}, \d{4})/);
    const cap = s => s.charAt(0) + s.slice(1).toLowerCase();
    const allot = [...all.matchAll(/^(INSURANCE|SAVINGS|BOND|CHARITY|DISCRETIONARY|NON-DISCRETIONARY|ALLOTMENT)\s+(.+?)\s+([\d,]*\.\d{2})\s*$/gm)]
      .map(m => ({ type: cap(m[1]), payee: m[2].trim(), amount: money(m[3]) }));
    const ytdTaxable = ytd('TAXABLE INCOME'), ytdWithheld = ytd('FEDERAL INCOME TAX WITHHELD');
    const paidMonths = taxable && ytdTaxable ? Math.round(ytdTaxable / taxable) : null;
    return { kind: 'ras', format: 'DFAS retiree account statement', fileName, asOf: dateM ? toDate(dateM[1]) : null, payDue: dateM ? toDate(dateM[2]) : null,
      gross, sbp: item('SBP COSTS') || 0, taxable: taxable != null ? taxable : gross, fitw: item('FITW') || 0, allotments: item('ALLOTMENTS') || 0, net, allot,
      ytdTaxable, ytdWithheld, paidMonths, status: (all.match(/WITHHOLDING STATUS:\s*([A-Z ]+?)\s*\n/) || [])[1] || null,
      crdp: money((all.match(/\(CRDP\) AMOUNT IS\s*\$([\d,]+\.\d{2})/i) || [])[1] || ''), sbpCoverage: (all.match(/SBP COVERAGE TYPE:\s*(.+?)\s+ANNUITY/i) || [])[1] || null,
      sbpAnnuity: money((all.match(/WHICH IS\s*([\d,]+\.\d{2})/i) || [])[1] || ''), txns: [], warnings: [] };
  }

  /* Form 1098 (mortgage interest) plus the lender's year-end summary printed with it: interest, starting and ending
     balance, principal paid, escrow for property tax and insurance. Interest and principal paid give the rate and,
     at the pace actually paid, the payoff date. Whether it's the home is read from box 8 matching the borrower's
     address. Account numbers and TINs are never kept. */
  const LENDERS = /\b(Freedom Mortgage|Rocket Mortgage|Quicken Loans|Mr\.? Cooper|Nationstar|Wells Fargo|Chase|JPMorgan|Bank of America|PennyMac|U\.?S\.? Bank|Navy Federal|USAA|Veterans United|Lakeview|NewRez|Shellpoint|Guild Mortgage|loanDepot|Flagstar|Truist|PNC|Citizens|Fifth Third|Huntington|Carrington|Cenlar|Dovenmuehle|Fairway|Movement Mortgage|CrossCountry|United Wholesale|Sallie Mae|Midland|Roundpoint|Planet Home|Specialized Loan|Selene|Servbank)\b/i;
  function parse1098(fileName, all) {
    const N = '([\\d,]+\\.\\d{2})';
    const box = re => { const m = all.match(re); return m ? money(m[1]) : null; };
    const interest = box(new RegExp('1 Mortgage interest received[\\s\\S]{0,160}?\\$\\s*' + N, 'i'));
    if (interest == null) return null;
    const start = box(new RegExp('2 Outstanding mortgage principal[\\s\\S]{0,240}?\\$\\s*' + N, 'i'));
    const orig = (all.match(/3 Mortgage origination date[\s\S]{0,240}?(\d{2}\/\d{2}\/\d{4})/i) || [])[1];
    const pmi = box(new RegExp('5 Mortgage insurance premiums[\\s\\S]{0,160}?\\$\\s*[\\d,]*\\.?\\d*\\s*\\$\\s*' + N, 'i'));
    const year = +((all.match(/For calendar year[\s\S]{0,200}?\b(20\d\d)\b/i) || all.match(/YEAR:\s*(20\d\d)/) || [])[1] || 0) || null;
    // the lender's summary prints "label $amount" or "$amount label" (often in side-by-side columns); read it the
    // way this document is laid out, judged by how many lines start with a dollar amount followed by words
    const amtFirst = (all.match(/^\$[\d,]+\.\d{2} [A-Za-z]/gm) || []).length >= 4;
    const lab = re => {
      const after = new RegExp('(?:' + re + ')\\s*:?\\s*\\$\\s*' + N, 'i'), before = new RegExp('\\$\\s*' + N + '\\s+(?:' + re + ')', 'i');
      const a = amtFirst ? all.match(before) || all.match(after) : all.match(after) || all.match(before);
      return a ? money(a[1]) : null;
    };
    const end = lab('Ending Balance|Remaining Balance|Ending Principal Balance|Principal Balance as of 12\\/31');
    const applied = lab('Applied Principal|Payments Applied|Principal Paid|Total Principal');
    const tax = lab('Property Tax(?:es)?(?: Disbursements)?|County Tax|Taxes Paid');
    const ins = lab('Hazard Insurance(?: Disbursements)?|Homeowners Insurance|Insurance Disbursements');
    const pi = lab('Current P&I Payment|Principal and Interest Payment|P&I Payment');
    const escrowPay = lab('Current Escrow Payment|Escrow Payment');
    const total = lab('Current Total Payment|Total Monthly Payment|Total Payment');
    const lenderM = all.match(LENDERS) || fileName.match(/\(([^)]+)\)/);
    const prop = (all.match(/8 Address or description of property[\s\S]*?\n\s*(\d+[A-Za-z]? [A-Z0-9][A-Z0-9 .#']+?)(?=\s+(?:reported|interest|or because)\b|\s*\n)/) || [])[1];
    const street = prop ? prop.trim().split(/\s+/).slice(0, 4).join(' ') : null;
    const borrowerBlock = all.slice(0, all.search(/8 Address or description of property/i) > 0 ? all.search(/8 Address or description of property/i) : 1500);
    const home = street ? new RegExp(street.split(' ').slice(0, 3).join('\\s+'), 'i').test(borrowerBlock) : null;
    // rate and payoff from what was actually paid: interest over the average balance; payment = (interest + principal) / 12
    const avg = start != null && end != null ? (start + end) / 2 : null;
    const rate = avg ? interest / avg : null;
    const pace = applied != null ? (interest + applied) / 12 : null, sched = pi || (total && escrowPay ? total - escrowPay : null);
    const months = (bal, pay) => { if (!bal || !pay || !rate) return null; const r = rate / 12; if (pay <= bal * r) return null; return Math.ceil(-Math.log(1 - r * bal / pay) / Math.log(1 + r)); };
    const nPace = months(end, pace), nSched = months(end, sched);
    const yr = n => n != null && year ? year + 1 + Math.floor((n - 1) / 12) : null;
    const pretty = s => s ? s.replace(/\b([A-Z])([A-Z]+)\b/g, (w, a, b) => a + b.toLowerCase()) : s;
    return { kind: 'f1098', format: 'Form 1098', fileName, year, lender: lenderM ? pretty(lenderM[1].replace(/\s+(LLC|INC)\.?$/i, '')) : 'Mortgage', property: pretty(prop ? prop.trim() : null), home,
      interest, startBalance: start, endBalance: end, principalPaid: applied, propertyTax: tax, insurance: ins, pmi: pmi || 0, origination: orig ? toDate(orig) : null,
      piPayment: sched, escrowPayment: escrowPay, totalPayment: total || (sched && escrowPay ? r2(sched + escrowPay) : null),
      rate, payoffPace: yr(nPace), payoffScheduled: yr(nSched), paceMonthly: pace, txns: [], warnings: [] };
  }

  /* Military Leave and Earnings Statement (DFAS Form 702, all branches). Read as a monthly pay stub so it feeds the
     Pay tab and Taxes page: gross = total entitlements, taxable = federal wage for the period, plus the year to date
     from the tax blocks. Allowances like BAH and BAS aren't taxed, which is the gap between the two. Name and SSN are
     never kept. */
  function parseLES(fileName, all) {
    const A = '(-?\\s*[\\d,]*\\.\\d{2})', v = re => { const m = all.match(re); return m ? money(m[1].replace(/\s/g, '')) : null; };
    const totEnt = v(new RegExp('\\+\\s*Tot Ent\\s+' + A)), totDed = v(new RegExp('-\\s*Tot Ded\\s+' + A)), totAllt = v(new RegExp('-\\s*Tot Allt\\s+' + A)) || 0;
    const netAmt = v(new RegExp('=\\s*Net Amt\\s+' + A)), eom = v(new RegExp('=\\s*EOM Pay\\s+' + A)), mid = v(new RegExp('MID-MONTH-PAY\\s+' + A)) || 0;
    if (totEnt == null || netAmt == null) return null;
    const hdr = all.match(/\*{3,}\d{4}\s+(\S+)\s+(\d{6})\s+(\d{1,2})\s+\S+\s+([A-Z][A-Z ]*?)\s+\d{4}\s+(\d{1,2})-(\d{1,2})\s+([A-Z]{3})\s+(\d{2})/);
    const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
    const y = hdr ? '20' + hdr[8] : null, mo = hdr ? MON[hdr[7]] : null;
    const begin = y && mo ? `${y}-${mo}-${String(hdr[5]).padStart(2, '0')}` : null, end = y && mo ? `${y}-${mo}-${String(hdr[6]).padStart(2, '0')}` : null;
    // FED: wage period, wage YTD, M/S, exemptions, additional tax, tax YTD; FICA: wage period, soc wage YTD, soc tax YTD, med wage YTD, med tax YTD
    const fed = all.match(/TAXES\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([MS])\s+(\d+)\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})/);
    const fica = all.match(/TAXES\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})(?!\s+[MS]\b)/);
    const state = all.match(/TAXES\s+([A-Z]{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([MSN])\s+(\d+)\s+([\d,]*\.\d{2})/);
    const cur = re => v(new RegExp(re + '\\s+' + A));
    const fedCur = cur('FEDERAL TAXES') || 0, socCur = cur('FICA-SOC SECURITY') || 0, medCur = cur('FICA-MEDICARE') || 0;
    const stateCur = cur('STATE TAXES') || 0;
    const tspTrad = cur('TRADITIONAL TSP') || 0, tspRoth = cur('ROTH TSP') || 0;
    const tsp = all.match(/TOTALS\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})\s+([\d,]*\.\d{2})/);
    const ytdEnt = v(/YTD ENTITLE\s+([\d,]*\.\d{2})/), ytdDed = v(/YTD DEDUCT\s+([\d,]*\.\d{2})/);
    const m2 = x => x == null ? null : money(x);
    const fedYtd = fed ? m2(fed[6]) : 0, socYtd = fica ? m2(fica[3]) : 0, medYtd = fica ? m2(fica[5]) : 0, stYtd = state ? m2(state[6]) : 0;
    const tspYtd = tsp ? m2(tsp[1]) : 0, rothYtd = tsp ? m2(tsp[4]) : 0;
    const allow = [...all.matchAll(/\b(BAH|BAS|OHA|COLA|FSH|FSA|HFP|IDP|CZTE|MIHA|CONUS COLA)\s+(-\s*)?([\d,]*\.\d{2})/g)]
      .map(m => ({ name: m[1], amount: money(m[3]) * (m[2] ? -1 : 1) })).filter((x, i, a) => a.findIndex(z => z.name === x.name) === i);
    const taxesYtd = r2((fedYtd || 0) + (socYtd || 0) + (medYtd || 0) + (stYtd || 0));
    const otherYtd = ytdDed != null ? r2(ytdDed - taxesYtd - (tspYtd || 0)) : null;
    const line = (name, current, ytd, kind) => ({ name, current, ytd, kind });
    return { kind: 'paystub', les: true, format: 'Military LES', fileName, employer: 'U.S. ' + (hdr ? hdr[4].trim().replace(/\b\w+/g, w => w.charAt(0) + w.slice(1).toLowerCase()) : 'Military'),
      payDate: end, begin, end, grade: hdr ? hdr[1] : null, yearsService: hdr ? +hdr[3] : null,
      // Tot Ded includes the mid-month payment already sent to the bank: the month's take-home is mid-month + end-of-month
      current: { gross: totEnt, taxable: fed ? m2(fed[1]) : null, taxes: r2(fedCur + socCur + medCur + stateCur), deductions: r2(totDed - mid), net: r2((eom != null ? eom : netAmt) + mid) },
      ytd: ytdEnt != null ? { gross: ytdEnt, taxable: fed ? m2(fed[2]) : null, taxes: taxesYtd, deductions: ytdDed, net: ytdDed != null ? r2(ytdEnt - ytdDed) : null } : null,
      taxes: [line('Federal income tax', fedCur, fedYtd, 'tax'), line('Social Security', socCur, socYtd, 'tax'), line('Medicare', medCur, medYtd, 'tax'), ...(state && (stYtd || stateCur) ? [line('State tax (' + state[1] + ')', stateCur, stYtd, 'tax')] : [])],
      before: [...(tspYtd - rothYtd ? [line('Traditional TSP', tspTrad, r2(tspYtd - rothYtd), 'retire')] : [])],
      after: [...(rothYtd ? [line('Roth TSP', tspRoth, rothYtd, 'retire')] : []), ...(otherYtd ? [line('SGLI, debts and other deductions', null, otherYtd, 'other')] : [])],
      employerPaid: [], deposits: [{ type: 'EOM', last4: '', amount: eom != null ? eom : netAmt }, ...(mid ? [{ type: 'Mid-month', last4: '', amount: mid }] : [])],
      allotments: totAllt, allowances: allow, taxFree: fed ? r2(totEnt - m2(fed[1])) : null,
      w4: { status: fed ? (fed[3] === 'M' ? 'Married' : 'Single') : null, exemptions: fed ? +fed[4] : null, extra: fed ? m2(fed[5]) : null, dependents: null, multipleJobs: null },
      txns: [], warnings: [] };
  }

  /* Form 1099-R (pensions, annuities, retirement plan payouts). Boxes are labelled by the IRS; the amount follows
     its label. Payer name is kept, recipient name/address/TIN never are. */
  function parse1099R(fileName, all) {
    const box = re => { const m = all.match(re); return m ? money(m[1]) : null; };
    const gross = box(/1 Gross Distribution[\s\S]{0,120}?\$\s*([\d,]+\.\d{2})/i);
    if (gross == null) return null;
    const taxable = box(/2a Taxable amount[\s\S]{0,160}?\$\s*([\d,]+\.\d{2})/i), withheld = box(/4 Federal income tax withheld[\s\S]{0,160}?\$\s*([\d,]+\.\d{2})/i);
    const year = +((all.match(/\b(20\d\d)\s+Profit-Sharing/) || all.match(/0101(20\d\d)-1231\1/) || all.match(/Form 1099-R[^\n]*?\b(20\d\d)\b/) || [])[1] || 0) || null;
    const payer = (all.match(/^\s*(Defense Finance and Accounting Service|Office of Personnel Management|[A-Z][A-Za-z.&, ]{3,60}?(?:Retirement System|Pension Fund|Pension Plan|Annuity|Insurance Company|Trust Company|Investments|Financial|Fidelity[A-Za-z ]*|Vanguard[A-Za-z ]*|Schwab[A-Za-z ]*))\s*$/m) || [])[1];
    const code = (all.match(/distribution code[^\n]*\n[^\n]*?\$[\d,]+\.\d{2}\s+([1-9A-Z]{1,2})\b/i) || [])[1] || null;
    const mil = /Military Retired Pay|Defense Finance/i.test(all);
    return { kind: 'r1099', format: 'Form 1099-R', fileName, year, payer: mil ? 'DFAS military retired pay' : payer ? payer.trim() : 'Payer', gross, taxable: taxable != null ? taxable : gross, withheld: withheld || 0,
      code, military: /Military Retired Pay|Defense Finance/i.test(all), txns: [], warnings: [] };
  }

  /* Social Security Statement (ssa.gov): monthly benefit for each starting age 62-70, full retirement age, birth date,
     the earnings record, and what family members could get. Ages and amounts wrap across lines in the PDF text, so
     they're read in order from the estimates block. */
  function parseSSA(fileName, all) {
    const block = (all.match(/Retirement Benefits([\s\S]{0,1500}?)(?:Age Retirement Benefits Start|Monthly Benefit Amount|Disability Benefits)/i) || [])[1] || '';
    const amts = [...block.matchAll(/\$([\d,]{4,6})(?!\d)/g)].map(m => money(m[1])).filter(v => v < 15000);
    const ages = [62, 63, 64, 65, 66, 67, 68, 69, 70], byAge = {};
    if (amts.length >= 9) ages.forEach((a, i) => byAge[a] = amts[i]);
    const mono = ages.every((a, i) => !i || byAge[a] >= byAge[ages[i - 1]]);
    const fra = +((all.match(/full retirement age is\s*(\d{2})/i) || [])[1] || 0) || null;
    const dob = (all.match(/birth:\s*([A-Z][a-z]+\.? \d{1,2}, \d{4})/) || [])[1];
    const asOf = (all.match(/^.*?\b([A-Z][a-z]+ \d{1,2}, \d{4})\s*$/m) || [])[1];
    const amt = re => { const m = all.match(re); return m ? money(m[1]) : null; };
    const earnings = [...all.matchAll(/^(\d{4})(?:-(\d{4}))? \$([\d,]+) \$([\d,]+)/gm)].map(m => ({ from: +m[1], to: +(m[2] || m[1]), ss: money(m[3]), medicare: money(m[4]) }));
    return { kind: 'ssa', format: 'Social Security statement', fileName, asOf: asOf ? toDate(asOf) : null, birthDate: dob ? toDate(dob) : null, fra,
      byAge: mono ? byAge : {}, disability: amt(/would\s+be about \$([\d,]+)/i), spouseAtFRA: amt(/Spouse, if benefits start at full retirement age:\s*\$([\d,]+)/i),
      child: amt(/Minor child:\s*\$([\d,]+)/i), familyMax: amt(/cannot be more than:\s*\$([\d,]+)/i), assumedEarnings: amt(/continue to earn\s*(?:\$[\d,]+\s*)?\$?([\d,]{6,})\s*per year/i),
      taxesPaid: { ss: amt(/Social Security taxes[\s\S]{0,40}?You paid:\s*\$([\d,]+)/i), medicare: amt(/You paid:\s*\$[\d,]+\s*You paid:\s*\$([\d,]+)/i) },
      earnings, txns: [], warnings: mono ? [] : ['Could not read the benefit-by-age table on this statement.'] };
  }

  /* A workplace retirement plan statement (401(k), 403(b), 457, TSP): beginning balance, what you and the
     employer put in, fees, market change, ending balance. Payroll contributions never pass through a bank. */
  function parsePlanStatement(fileName, pages) {
    const all = pages.join('\n');
    const per = all.match(/(?:Statement Period|Period)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:to|-|–|through)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const val = re => { const m = all.match(re); return m ? money(m[1].replace(/\s/g, '')) : null; };
    const AMT = '(-?\\(?\\$?-?[\\d,]+\\.\\d{2}\\)?)';
    const begin = val(new RegExp('Beginning Balance\\s*' + AMT, 'i')), end = val(new RegExp('Ending Balance\\s*' + AMT, 'i'));
    if ((!per || begin == null || end == null) && /Thrift Savings Plan/i.test(all)) return parseTSPPortfolio(fileName, all);
    if (!per || begin == null || end == null) return null;
    const employee = val(new RegExp('(?:Employee|Your|Participant) Contributions\\s*' + AMT, 'i')) || 0;
    const employer = val(new RegExp('(?:Employer|Company|Agency|Matching) Contributions\\s*' + AMT, 'i')) || 0;
    const fees = val(new RegExp('(?:Administrative )?Fees\\s*' + AMT, 'i')) || 0;
    const market = val(new RegExp('(?:Change in Market Value|Market (?:Gain|Change)|Investment (?:Gain|Earnings))[^\\n$-]*' + AMT, 'i'));
    const withdrawals = val(new RegExp('(?:Withdrawals|Distributions|Loans? Issued)\\s*' + AMT, 'i')) || 0;
    const broker = /fidelity/i.test(all) ? 'Fidelity' : /vanguard/i.test(all.slice(0, 3000)) && !/target \d{4}/i.test(all.slice(0, 600)) ? 'Vanguard' : /thrift savings|\bTSP\b/i.test(all) ? 'TSP' : /empower/i.test(all) ? 'Empower' : /principal/i.test(all) ? 'Principal' : 'Retirement plan';
    const planName = (all.match(/^\s*(.{3,60}?)\s+(?:Plan\s+)?(?:Retirement Savings|401\(?k\)?|403\(?b\)?|457)\s+Statement/im) || [])[1];
    const kind = /403\(?b\)?/i.test(all) ? '403(b)' : /\b457\b/.test(all) ? '457' : broker === 'TSP' ? 'TSP' : '401(k)';
    const name = broker === 'TSP' ? 'TSP' : `${(planName || broker).replace(/\s+Plan$/i, '').trim()} ${kind}`;
    // balance by money source (Pre-Tax, Roth, match...): the Roth share has no required withdrawals and isn't taxed
    let roth = 0, srcTotal = 0, prev = '';
    for (const ln of all.split('\n')) {
      const m = ln.match(/^(.*?)\s*\$[\d,]+\.\d{2}\s+\$[\d,]+\.\d{2}\s+\d+%\s+\$([\d,]+\.\d{2})\s+\$[\d,]+\.\d{2}\s*$/);
      if (m) { const v = money(m[2]); srcTotal += v; if (/roth/i.test(m[1] || prev)) roth += v; }
      prev = ln;
    }
    const rothShare = srcTotal > 0 && Math.abs(srcTotal - end) / end < 0.02 ? roth / srcTotal : null;
    return {
      kind: 'statement', plan: true, format: broker + ' retirement plan statement', broker, fileName, accountType: kind, last4: '',
      start: toDate(per[1]), end: toDate(per[2]), open: begin, close: end, employee, employer, fees: Math.abs(fees), withdrawals: Math.abs(withdrawals),
      market: market != null ? market : r2(end - begin - employee - employer + Math.abs(fees) + Math.abs(withdrawals)),
      dividends: null, contributions: r2(employee + employer), text: all, txns: [], warnings: [], account: name, rothShare, rothBalance: rothShare != null ? r2(roth) : null,
    };
  }

  /* tsp.gov "Investments" page saved as PDF: each fund's balance, its gain over the period shown, and any other
     activity (contributions, withdrawals). Start balance = end − gains − other activity. */
  function parseTSPPortfolio(fileName, all) {
    const per = all.match(/([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*(?:to|-|–)\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
    const asOf = all.match(/As of ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
    const funds = [...all.matchAll(/\b(?:([GFCSI]) Fund|L (\d{4}|Income)(?: Fund)?)(?: \(PDF\))?\s+(\(?-?\$[\d,]+\.\d{2}\)?)/g)];
    if (!funds.length || !(per || asOf)) return null;
    const close = r2(funds.reduce((x, m) => x + money(m[3]), 0));
    const gain = r2([...all.matchAll(/\bGain\s+(\(?-?\$[\d,]+\.\d{2}\)?)/g)].reduce((x, m) => x + money(m[1]), 0));
    const other = r2([...all.matchAll(/Other Activity\s+(\(?-?\$[\d,]+\.\d{2}\)?)/g)].reduce((x, m) => x + money(m[1]), 0));
    const end = toDate(per ? per[2] : asOf[1]);
    const start = per ? toDate(per[1]) : end;
    const service = /Uniformed Services/i.test(all) ? 'Uniformed Services' : '';
    return {
      kind: 'statement', plan: true, format: 'TSP investments page', broker: 'TSP', fileName, accountType: 'TSP', last4: '',
      start, end, open: r2(close - gain - other), close, employee: other > 0 ? other : 0, employer: 0, fees: 0, withdrawals: other < 0 ? -other : 0,
      market: gain, dividends: null, contributions: other > 0 ? other : 0, text: all, txns: [], warnings: [],
      account: 'TSP' + (service ? ' (' + service + ')' : ''),
    };
  }

  function parseOFX(fileName, text) {
    const tag = (blk, t) => { const m = blk.match(new RegExp('<' + t + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
    const card = /<CCACCTFROM>/i.test(text);
    const acct = (tag(text, 'ACCTID') || '').replace(/\D/g, '').slice(-4);
    const base = accountBase(fileName) + (acct ? ' ••' + acct : '');
    const org = tag(text, 'ORG');
    const out = [];
    for (const blk of text.split(/<STMTTRN>/i).slice(1)) {
      const date = toDate(tag(blk, 'DTPOSTED')), amt = money(tag(blk, 'TRNAMT'));
      if (!date || amt == null) continue;
      const name = tag(blk, 'NAME'), memo = tag(blk, 'MEMO');
      const desc = name && memo && !memo.toUpperCase().includes(name.toUpperCase()) ? `${name} ${memo}` : (name || memo);
      out.push({ date, amount: amt, desc, raw: desc, srcCat: '', card: acct, owner: '', type: tag(blk, 'TRNTYPE'),
        file: fileName, account: base, accountType: card ? 'card' : 'bank', issuer: issuerOf(org + ' ' + fileName) });
    }
    return { format: 'OFX/QFX', flipped: false, txns: out, warnings: [], accountBase: base };
  }

  // ---------- rules ----------
  const RX = {
    cardPayIn: /PAYMENT|THANK YOU|AUTOPAY|AUTO PAY|PYMT|\bPMT\b|MOBILE PYMT/,
    transferish: /TRANSFER|\bTFR\b|XFER|FUNDS TRANSFER|ONLINE BANKING|AUTOPAY|PAYMENT|\bPMT\b|PYMT|MONEYLINK|ADVANCE TRANSFER|DEPOSIT FROM|WITHDRAWAL TO|\bTO SAV|\bTO CHK|INTERNET TRANSFER/,
    sentOut: /TRANSFER|\bTFR\b|XFER|MONEYLINK|ADVANCE TRANSFER|WITHDRAWAL TO|\bTO SAV|\bTO CHK|RECUR/,
    p2p: /ZELLE|VENMO|CASH APP|CASHAPP|PAYPAL TRANSFER|PAYPAL \*|APPLE CASH|SQUARE CASH|REVOLUT|ONEPAY/,
    fee: /\bFEES?\b|INTEREST CHARGE|FINANCE CHARGE|OVERDRAFT|\bNSF\b|LATE CHARGE|SERVICE CHARGE|FOREIGN TRANSACTION|ANNUAL MEMBERSHIP/,
    atm: /\bATM\b|CASH WITHDRAWAL|WITHDRAWAL AT/,
    check: /^CHECK\b|^CHECK #|^CHK\b|\bCHECK\s*#?\s*\d/,
    bnpl: /AFTERPAY|KLARNA|AFFIRM|SEZZLE|ZIP\.CO|PAYPAL PAY IN 4/,
    mortgage: /MORTGAGE|\bMTG\b|HOME LOAN|ESCROW/,
    loan: /\bLOAN\b|CREDIT UNION|\bFCU\b|\bCU (RECUR|LOAN|PMT|PAYMENT|AUTO)|LOAN PMT|LIGHTSTREAM|NAVIENT|NELNET|MOHELA|AIDVANTAGE|EDFINANCIAL|SOFI LN|UPSTART|LENDING ?CLUB|PROSPER|AUTO LOAN|ALLY PAYMT|TOYOTA FIN|HONDA FIN|FORD CREDIT|GM FINANCIAL|SANTANDER|CARMAX AUTO|BRIDGECREST|VW CREDIT/,
    invest: /ROBINHOOD(?! CARD)|SCHWAB|FIDELITY|VANGUARD|E\*?TRADE|WEBULL|M1 FINANCE|ACORNS|BETTERMENT|WEALTHFRONT|TREASURY ?DIRECT|TASTYTRADE|INTERACTIVE BROKERS|PUBLIC\.COM|BROKERAGE|\b529\b|STASH/,
    tax: /IRS USATAXPYMT|IRS TREAS 310 TAX|STATE TAX|DEPT OF REVENUE|FRANCHISE TAX|\bTAXPYMT\b/,
    interestIn: /INTEREST (PAID|CREDIT|EARNED|PAYMENT)|\bDIVIDEND|\bDIV\b|INT EARNED/,
    cashback: /CASH ?BACK|REWARDS? (REDEMPTION|CREDIT)|STATEMENT CREDIT|REBATE|REIMBURS|REFUND/,
    payroll: /PAYROLL|PAYRL|DIR DEP|DIRECT DEP|DIRECTDEP|SALARY|PAYCHECK|\bACH PAY\b|\bPAY\b|\bWAGES\b/,
  };
  // federal deposits look the same at every bank (the Treasury sends them)
  const GOV = [
    [/DFAS.{0,20}RET/, 'Military retired pay', 'pension'],
    [/DFAS/, 'Military pay', 'paycheck'],
    [/XXVA BENEF|VA BENEFIT|TREAS 310.{0,12}VA\b|\bVACP TREAS/, 'VA disability', 'benefit'],
    [/XXSOC SEC|SSA TREAS|SOC SEC/, 'Social Security', 'benefit'],
    [/XXSUPP SEC|SSI TREAS/, 'SSI', 'benefit'],
    [/OPM\d? .{0,10}TREAS|CSA ANNUITY|CSF ANNUITY|OPM ANNUITY/, 'Federal retirement (OPM)', 'pension'],
    [/IRS TREAS 310|TAX REF/, 'Tax refund', 'other_income'],
    [/RRB TREAS|RAILROAD RET/, 'Railroad retirement', 'pension'],
  ];
  const CARD_PAY_OUT = [
    ['capitalone', /CAPITAL ONE.{0,20}(PMT|PYMT|PAYMENT)|CAPITALONE/],
    ['citi', /CITI ?(AUTOPAY|CARD|PAYMENT|ONLINE)|CITICARD|CITI AUTOPAY/],
    ['chase', /CHASE CREDIT CRD|CHASE CARD|CHASE EPAY|CHASE AUTOPAY/],
    ['amex', /AMEX EPAYMENT|AMERICAN EXPRESS (ACH|PMT|PAYMENT)/],
    ['discover', /DISCOVER (E-?PAYMENT|CARD|PAYMENT)|DISCOVER DC PYMT/],
    ['usaa', /USAA CREDIT CARD PAYMENT|USAA CC PAYMENT/],
    ['robinhood', /ROBINHOOD CARD|RH CARD/],
    ['apple', /APPLECARD|APPLE CARD|GSBANK PAYMENT/],
    ['barclays', /BARCLAYCARD|BARCLAYS/],
    ['synchrony', /SYNCHRONY|SYNCB/],
    ['', /CARDMEMBER SERV|CREDIT CARD PAYMENT|CRCARDPMT|CC PAYMENT|CARD PAYMENT|CREDIT CRD|CRD PMT|EPAYMENT/],
  ];
  // merchant words that settle the category regardless of what the bank said
  const MERCHANT_CAT = [
    [/COSTCO GAS|\bSHELL\b|CHEVRON|EXXON|MOBIL\b|\bARCO\b|MAVERIK|CIRCLE K|SINCLAIR|\b76\b|VALERO|CONOCO|PHILLIPS 66|TEXACO|\bFUEL|GAS STATION|\bGAS\b|JIFFY LUBE|DISCOUNT TIRE|LES SCHWAB|AUTOZONE|O'?REILLY|NAPA|CAR WASH|PARKING|DMV|DEPT OF LICENSING|VEHICLE LICENS|TOLL/, 'Auto & gas'],
    [/DOORDASH|UBER EATS|GRUBHUB|MCDONALD|WENDY|TACO BELL|BURGER|CHICK-?FIL|STARBUCKS|DUTCH BROS|SUBWAY|PIZZA|DOMINO|PANDA EXPRESS|CHIPOTLE|365 MARKET|CAFE|COFFEE|ESPRESSO|RESTAURANT|GRILL|BREWING|TAVERN|DINER|SUSHI|TERIYAKI|BAKERY|DONUT|JACK IN THE BOX|ARBY|SONIC|DAIRY QUEEN|CARL'?S JR|DEL TACO|FIVE GUYS|IN-N-OUT|POPEYES|KFC|JIMMY JOHN|JERSEY MIKE|CRUMBL/, 'Dining out'],
    [/COSTCO|SAFEWAY|FRED[- ]?MEYER|KROGER|WINCO|ALBERTSONS|TRADER JOE|WHOLE FOODS|ROSAUERS|YOKE'?S|\bALDI\b|\bHEB\b|PUBLIX|SPROUTS|GROCERY|SUPERMARKET|SMITH'?S FOOD|HARRIS TEETER|WEGMANS|FOOD LION|GIANT EAGLE|MEIJER|HY-VEE|INSTACART/, 'Groceries'],
    [/AMAZON DIGIT|AMZN DIGITAL|KINDLE|ANGEL STUDIOS|NETFLIX|HULU|SPOTIFY|DISNEY|YOUTUBE|APPLE\.COM\/BILL|PRIME VIDEO|AMAZON PRIME|PEACOCK|PARAMOUNT|AUDIBLE|PATREON|ICLOUD|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|ADOBE|MICROSOFT|DROPBOX|SIRIUS|NYTIMES|WSJ|SUBSTACK|GOOGLE STORAGE|GOOGLE ONE|PLAYSTATION|XBOX|NINTENDO|STEAM ?GAMES|TWITCH|CRUNCHYROLL|BILIBILI|MASTERCLASS|DUOLINGO|ANNUAL SUBSCRIPTION|MEMBERSHIP FEE/, 'Subscriptions'],
    [/AVISTA|\bPUD\b|PUGET SOUND ENERGY|DUKE ENERGY|PG&E|EDISON|WATER|SEWER|GARBAGE|WASTE|COMCAST|XFINITY|VERIZON|T-MOBILE|TMOBILE|AT&T|\bATT\b|TICKTALK|SPECTRUM|STARLINK|ZIPLY|CENTURYLINK|LUMEN|COX COMM|MINT MOBILE|VISIBLE|CRICKET|GOOGLE FI|NATURAL GAS|ELECTRIC CO|POWER CO/, 'Utilities & phone'],
    [/GEICO|PROGRESSIVE|STATE FARM|ALLSTATE|LIBERTY MUTUAL|FARMERS INS|NATIONWIDE|USAA (P&C|INS)|INSURANCE|\bINS PREM|METLIFE|PRUDENTIAL|NORTHWESTERN MUT|ETHOS|LEMONADE/, 'Insurance'],
    [/HOME DEPOT|HOMEDEPOT|LOWE'?S|ACE HARDWARE|FENCE|FLOOR|GARAGE DOOR|CARPET|CABINET|COUNTERTOP|CONCRETE|HANDYMAN|REMODEL|CONTRACTOR|GUTTER|WINDOW|APPLIANCE|TRUE VALUE|MENARDS|HARBOR FREIGHT|NURSERY|LANDSCAP|POOL|PEST|PLUMB|ROOFING|HVAC|SPRINKLER/, 'Home & yard'],
    [/YMCA|HOCKEY|SPORTS ACADEM|FLAG FOOTBALL|LITTLE LEAGUE|SKYHAWKS|\bCAMP\b|SCHOOL|DAYCARE|CHILD ?CARE|TUTOR|KUMON|SOCCER|BASEBALL|GYMNASTICS|DANCE STUDIO|TOYS|CHUCK E|PEDIATRIC/, 'Kids & family'],
    [/AIRLINE|ALASKA AIR|DELTA AIR|UNITED AIR|SOUTHWEST|AMERICAN AIR|JETBLUE|HOTEL|MARRIOTT|HILTON|HYATT|AIRBNB|VRBO|EXPEDIA|BOOKING\.COM|AVIS|HERTZ|ENTERPRISE RENT|NATIONAL CAR|BUDGET RENT|TURO|CRUISE/, 'Travel'],
    [/CVS|WALGREENS|RITE AID|PHARMACY|DENTAL|DENTIST|ORTHO|CLINIC|HOSPITAL|MEDICAL|URGENT CARE|LABCORP|QUEST DIAG|OPTOM|VISION|CHIROPRACT|PHYSICAL THERAPY|HEALTH/, 'Health'],
    [/SALON|BARBER|WAX C|DRY CLEAN|CLEANERS|SPA\b|NAIL|ULTA|SEPHORA|GREAT CLIPS|SUPERCUTS|MASSAGE|PLANET FITNESS|\bGYM\b|FITNESS|CROSSFIT/, 'Personal care'],
    [/CINEMA|THEATER|THEATRE|REGAL|AMC |FANDANGO|TICKETMASTER|STUBHUB|BOWLING|GOLF|CASINO|MUSEUM|\bZOO\b|CONCERT|ARCADE/, 'Entertainment'],
    [/AMAZON|AMZN|WALMART|WAL-MART|TARGET|BEST BUY|EBAY|ETSY|KOHL|MACY|NORDSTROM|TJ ?MAXX|MARSHALLS|ROSS STORES|OLD NAVY|GAP\b|DSW|NIKE|SHEIN|TEMU|GROUPON|PAYPAL PURCHASE|IKEA|WAYFAIR|BED BATH|MICHAELS|HOBBY LOBBY|JOANN|DOLLAR TREE|DOLLAR GENERAL|FAMILY DOLLAR/, 'Shopping'],
    [/CHURCH|DONATION|CHARITY|RED CROSS|UNITED WAY|GOFUNDME|TITHE|\bGIFT\b|FLOWERS|1-800-FLOWERS|HALLMARK/, 'Gifts & giving'],
    [/UNIVERSITY|COLLEGE|TUITION|COURSERA|UDEMY|STUDENT|BOOKSTORE|CENTERLINE/, 'Education'],
    [/IRS|TAX\b|TREASURER|COUNTY TREAS|ASSESSOR/, 'Taxes'],
  ];
  // the bank's own category, when it gave one
  const SRC_CAT = {
    'fast food': 'Dining out', 'restaurants': 'Dining out', 'food & dining': 'Dining out', 'coffee shops': 'Dining out', 'dining': 'Dining out', 'alcohol & bars': 'Dining out', 'food & drink': 'Dining out',
    'groceries': 'Groceries', 'supermarkets': 'Groceries', 'grocery': 'Groceries',
    'shopping': 'Shopping', 'clothing': 'Shopping', 'electronics & software': 'Shopping', 'sporting goods': 'Shopping', 'books': 'Shopping', 'shipping': 'Shopping', 'merchandise': 'Shopping', 'department stores': 'Shopping', 'home': 'Shopping', 'hobbies': 'Shopping',
    'gas': 'Auto & gas', 'auto & transport': 'Auto & gas', 'service & parts': 'Auto & gas', 'parking': 'Auto & gas', 'gas/automotive': 'Auto & gas', 'vehicle services': 'Auto & gas', 'gasoline': 'Auto & gas', 'automotive': 'Auto & gas', 'auto insurance': 'Insurance', 'auto payment': 'Loans',
    'bills & utilities': 'Utilities & phone', 'utilities': 'Utilities & phone', 'television': 'Subscriptions', 'mobile phone': 'Utilities & phone', 'internet': 'Utilities & phone', 'phone/cable': 'Utilities & phone', 'phone': 'Utilities & phone',
    'mortgage & rent': 'Housing', 'rent': 'Housing', 'mortgage': 'Housing',
    'pharmacy': 'Health', 'doctor': 'Health', 'health care': 'Health', 'dentist': 'Health', 'health & fitness': 'Health', 'medical': 'Health', 'health': 'Health',
    'personal care': 'Personal care', 'hair': 'Personal care', 'gym': 'Personal care',
    'entertainment': 'Entertainment', 'movies & dvds': 'Entertainment', 'music': 'Entertainment', 'arts': 'Entertainment', 'amusement': 'Entertainment',
    'gifts & donations': 'Gifts & giving', 'charity': 'Gifts & giving', 'organizations': 'Gifts & giving', 'gift': 'Gifts & giving',
    'home improvement': 'Home & yard', 'home services': 'Home & yard', 'lawn & garden': 'Home & yard', 'furnishings': 'Home & yard',
    'education': 'Education', 'tuition': 'Education',
    'atm fee': 'Fees & interest', 'bank fee': 'Fees & interest', 'fees & charges': 'Fees & interest', 'finance charge': 'Fees & interest', 'late fee': 'Fees & interest', 'service fee': 'Fees & interest', 'fees & adjustments': 'Fees & interest', 'interest': 'Fees & interest',
    'cash': 'Cash & ATM', 'cash & atm': 'Cash & ATM', 'atm': 'Cash & ATM',
    'travel': 'Travel', 'airfare': 'Travel', 'lodging': 'Travel', 'car rental': 'Travel', 'other travel': 'Travel', 'hotel': 'Travel', 'rental car & taxi': 'Travel', 'taxi': 'Travel',
    'insurance': 'Insurance', 'life insurance': 'Insurance', 'health insurance': 'Insurance',
    'kids': 'Kids & family', 'child care': 'Kids & family', 'babysitter & daycare': 'Kids & family', 'pets': 'Kids & family', 'pet food & supplies': 'Kids & family',
    'taxes': 'Taxes', 'federal tax': 'Taxes', 'state tax': 'Taxes', 'property tax': 'Taxes',
    'subscriptions': 'Subscriptions', 'streaming': 'Subscriptions',
  };

  function categorize(t) {
    const up = (t.desc + ' ' + t.raw).toUpperCase();
    if (RX.fee.test(up)) return 'Fees & interest';
    if (RX.bnpl.test(up)) return 'Buy now, pay later';
    for (const [re, cat] of MERCHANT_CAT) if (re.test(up)) return cat;
    const s = SRC_CAT[String(t.srcCat || '').toLowerCase()];
    return s || 'Other';
  }

  // ---------- assembling and classifying ----------
  /* files: [{name, result}] from parseFile. prefs: answers the person gave (all optional):
     { payers:{key:choice}, outs:{key:choice}, merchants:{key:category}, txns:{id:{category, counts}},
       accounts:{name:{name, type}} }   Returns everything the page shows. */
  function analyze(files, prefs) {
    prefs = Object.assign({ payers: {}, outs: {}, merchants: {}, txns: {}, accounts: {} }, prefs || {});
    // 1. pool all rows; drop the copies that come from overlapping exports of the same account
    // investment exports carry no account number: files that share rows are the same account
    const invFiles = files.filter(f => f.result && f.result.kind === 'invest');
    const sets = invFiles.map(f => new Set(f.result.txns.map(t => t.date + '|' + t.amount.toFixed(2) + '|' + t.raw)));
    const parent = invFiles.map((_, i) => i);
    const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
      let shared = 0;
      for (const s of sets[i]) if (sets[j].has(s) && ++shared >= 3) break;
      if (shared >= 3) parent[root(j)] = root(i);
    }
    const groupFiles = {};
    invFiles.forEach((f, i) => (groupFiles[root(i)] || (groupFiles[root(i)] = [])).push(f));
    const lastOf = fs => fs.reduce((m, f) => f.result.txns.reduce((a, t) => t.date > a ? t.date : a, m), '');
    const groups = Object.values(groupFiles).sort((a, b) => lastOf(b) < lastOf(a) ? -1 : 1);
    // monthly statements name the account; an export belongs to the account whose statements show its amounts
    const stmts = [];
    for (const f of files) {
      const s = f.result;
      if (!s || s.kind !== 'statement' || stmts.some(x => x.account === s.account && x.start === s.start)) continue;
      stmts.push(Object.assign({}, s, { account: (prefs.accounts[s.account] || {}).name || s.account, origAccount: s.account }));
    }
    const fmtAmt = n => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const invName = {}, linked = {};
    let letter = 0;
    groups.forEach(fs => {
      const rows = fs.flatMap(f => f.result.txns).filter(t => Math.abs(t.amount) >= 1);
      const score = {};
      for (const s of stmts) {
        const inside = rows.filter(t => t.date >= s.start && t.date <= s.end);
        if (!inside.length) continue;
        const sc = score[s.origAccount] || (score[s.origAccount] = { hit: 0, n: 0 });
        sc.n += inside.length;
        sc.hit += inside.filter(t => s.text.includes(fmtAmt(t.amount))).length;
      }
      const best = Object.entries(score).filter(([, v]) => v.hit >= 3 && v.hit / v.n >= 0.5).sort((a, b) => b[1].hit / b[1].n - a[1].hit / a[1].n)[0];
      const name = best ? best[0] : null;
      fs.forEach(f => { invName[f.name] = name || f.result.broker + ' investing ' + String.fromCharCode(65 + letter); if (name) linked[f.name] = name; });
      if (!name) letter++;
    });

    // the same account exported twice under different file names (a renamed or older copy): if most rows of one
    // account also appear in another, fold it into that account so the row-level dedupe below removes the overlap
    const fileAccts = [];
    for (const f of files) {
      if (invName[f.name]) continue;
      const by = {};
      for (const t of (f.result && f.result.txns) || []) (by[t.account] = by[t.account] || []).push(t.date + '|' + t.amount.toFixed(2) + '|' + String(t.raw).toUpperCase().replace(/\s+/g, ' ').trim());
      for (const [acct, sigs] of Object.entries(by)) fileAccts.push({ file: f.name, acct, set: new Set(sigs), n: sigs.length });
    }
    const sameAs = {}, copies = [];
    fileAccts.sort((a, b) => b.n - a.n);
    for (let i = 0; i < fileAccts.length; i++) for (let j = i + 1; j < fileAccts.length; j++) {
      const big = fileAccts[i], small = fileAccts[j];
      if (small.acct === big.acct || sameAs[small.acct] || small.n < 20) continue;
      let hit = 0;
      for (const s of small.set) if (big.set.has(s)) hit++;
      if (hit / small.set.size >= 0.8) { sameAs[small.acct] = sameAs[big.acct] || big.acct; copies.push({ file: small.file, account: small.acct, sameAs: sameAs[small.acct], shared: hit, rows: small.n }); }
    }

    const all = [], seen = new Map(), dupes = [];
    for (const f of files) {
      const counts = new Map();
      for (const t0 of (f.result && f.result.txns) || []) {
        const t = Object.assign({}, t0);
        if (invName[f.name]) t.account = invName[f.name];
        if (sameAs[t.account]) t.account = sameAs[t.account];
        t.origAccount = t.account;
        const ap = prefs.accounts[t.account] || {};
        if (ap.name) t.account = ap.name;
        if (ap.type) t.accountType = ap.type;
        if (ap.flip) t.amount = -t.amount;
        const sig = [t.account, t.date, t.amount.toFixed(2), String(t.raw).toUpperCase().replace(/\s+/g, ' ').trim()].join('|');
        const n = (counts.get(sig) || 0) + 1;
        counts.set(sig, n);
        const k = sig + '|' + n;
        const prev = seen.get(k);
        if (prev && prev.file !== t.file) { dupes.push({ kept: prev, dropped: t }); continue; }
        t.id = k;
        seen.set(k, t);
        all.push(t);
      }
    }
    all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const accounts = {};
    for (const t of all) {
      const a = accounts[t.account] || (accounts[t.account] = { name: t.account, orig: t.origAccount, type: t.accountType, issuer: t.issuer, owner: t.owner, count: 0, first: t.date, last: t.date, files: new Set() });
      a.count++; a.last = t.date; a.files.add(t.file);
      if (!a.owner && t.owner) a.owner = t.owner;
      const m = merchantOf(t.desc);
      t.key = m.key; t.name = m.name; t.up = (t.desc + ' ' + t.raw).toUpperCase();
    }
    const loadedIssuers = new Set(Object.values(accounts).filter(a => a.type === 'card' && a.issuer).map(a => a.issuer));
    // the household picture covers the dates the bank and card files cover; older brokerage history is kept for the investments view
    const hh = all.filter(t => t.accountType !== 'invest'), span = hh.length ? hh : all;
    const wStart = span.length ? span[0].date : null, wEnd = span.length ? span[span.length - 1].date : null;
    for (const t of all) t.inWindow = t.date >= wStart && t.date <= wEnd;

    // 1b. deposits into and withdrawals out of investment accounts, matched to the bank side so they count once
    for (const v of all) {
      if (v.accountType !== 'invest' || (v.invKind !== 'deposit' && v.invKind !== 'withdrawal')) continue;
      const want = (-v.amount).toFixed(2);
      const c = all.filter(b => !b.pair && b.accountType === 'bank' && b.amount.toFixed(2) === want && Math.abs(days(b.date, v.date)) <= 6);
      if (!c.length) continue;
      c.sort((x, y) => Math.abs(days(x.date, v.date)) - Math.abs(days(y.date, v.date)));
      const b = c[0];
      b.pair = v; v.pair = b;
      v.counts = 'inv'; v.category = v.invKind === 'deposit' ? 'Deposit from my bank' : 'Withdrawal to my bank';
      if (v.invKind === 'deposit') { b.counts = 'saving'; b.category = 'Savings & investing'; }
      else { b.counts = 'withdrawal'; b.category = 'Taken from investments'; }
    }

    // 2. money moving between the person's own loaded accounts: equal and opposite, within 5 days
    const outs = all.filter(t => t.amount < 0), ins = all.filter(t => t.amount > 0);
    const insByAmt = new Map();
    for (const t of ins) { const k = t.amount.toFixed(2); (insByAmt.get(k) || insByAmt.set(k, []).get(k)).push(t); }
    for (const o of outs) {
      if (!RX.transferish.test(o.up) && !RX.cardPayIn.test(o.up)) continue;
      const cands = (insByAmt.get((-o.amount).toFixed(2)) || []).filter(i => !i.pair && i.account !== o.account
        && days(o.date, i.date) >= -2 && days(o.date, i.date) <= 5 && (RX.transferish.test(i.up) || i.accountType === 'card'));
      if (!cands.length) continue;
      cands.sort((a, b) => Math.abs(days(o.date, a.date)) - Math.abs(days(o.date, b.date)));
      const i = cands[0];
      o.pair = i; i.pair = o;
      o.counts = i.counts = 'internal';
      o.category = i.category = i.accountType === 'card' ? 'Card payment' : 'Transfer between my accounts';
    }

    // 3. everything else, one row at a time
    for (const t of all) {
      if (t.counts) continue;
      const up = t.up;
      if (t.accountType === 'invest') {
        const k = t.invKind || 'trade';
        t.counts = k === 'deposit' ? 'saving' : k === 'withdrawal' ? 'withdrawal' : 'inv';
        t.category = INV_LABEL[k];
        continue;
      }
      if (t.amount < 0) {
        if (t.accountType === 'bank') {
          const iss = CARD_PAY_OUT.find(([, re]) => re.test(up));
          if (iss) {
            if (iss[0] && loadedIssuers.has(iss[0])) {
              t.counts = 'internal'; t.category = 'Card payment';
              const cards = Object.values(accounts).filter(a => a.type === 'card' && a.issuer === iss[0]).map(a => a.name);
              t.otherCard = cards.length === 1 ? cards[0] : cards[0].replace(/\s*••\d+$/, '') + ' cards';
            }
            else { t.counts = 'spend'; t.category = 'Card payments (card not loaded)'; t.review = 'card'; }
            continue;
          }
          if (RX.mortgage.test(up)) { t.counts = 'spend'; t.category = 'Housing'; continue; }
          if (RX.loan.test(up)) { t.counts = 'spend'; t.category = 'Loans'; continue; }
          if (RX.invest.test(up)) { t.counts = 'saving'; t.category = 'Savings & investing'; continue; }
          if (RX.p2p.test(up) && !RX.bnpl.test(up)) { t.counts = 'spend'; t.category = 'People (Venmo/Zelle/Cash App)'; continue; }
          if (RX.check.test(up)) { t.counts = 'spend'; t.category = 'Checks'; t.review = 'check'; continue; }
          if (RX.atm.test(up) && !RX.fee.test(up)) { t.counts = 'spend'; t.category = 'Cash & ATM'; continue; }
          if (RX.tax.test(up)) { t.counts = 'spend'; t.category = 'Taxes'; continue; }
          if (RX.bnpl.test(up)) { t.counts = 'spend'; t.category = 'Buy now, pay later'; continue; }
          const c0 = categorize(t);
          if (c0 !== 'Other') { t.counts = 'spend'; t.category = c0; continue; }
          if (RX.sentOut.test(up) && !RX.fee.test(up)) { t.counts = 'unknown_out'; t.category = 'Sent to an account not loaded'; t.review = 'out'; continue; }
        } else if (RX.p2p.test(up) && !RX.bnpl.test(up)) { t.counts = 'spend'; t.category = 'People (Venmo/Zelle/Cash App)'; continue; }
        t.counts = 'spend';
        t.category = categorize(t);
      } else {
        if (t.accountType === 'card') {
          if (RX.cardPayIn.test(up)) { t.counts = 'internal'; t.category = 'Card payment'; continue; }
          t.counts = 'offset'; t.category = categorize(t); t.refund = true; continue;
        }
        const gov = GOV.find(([re]) => re.test(up));
        if (gov) { t.counts = 'income'; t.incomeType = gov[2]; t.source = gov[1]; continue; }
        if (RX.interestIn.test(up)) { t.counts = 'income'; t.incomeType = 'interest'; t.source = 'Interest & dividends'; continue; }
        if (RX.cashback.test(up)) { t.counts = 'offset'; t.category = 'Other'; t.refund = true; continue; }
        if (RX.payroll.test(up) && !RX.p2p.test(up) && !RX.transferish.test(up)) {
          t.counts = 'income'; t.incomeType = 'paycheck';
          t.source = 'Paycheck: ' + titleCase(cleanDesc(t.desc).replace(/\b(PAYROLL|PAYRL|DIR DEP|DIRECT DEP(OSIT)?|SALARY|ACH PAY|PAY|INC|LLC|DB|CO|CORP|INDU)\b/g, ' ').replace(/\s+/g, ' ').trim() || t.name);
          continue;
        }
        if (RX.p2p.test(up)) { t.counts = 'offset'; t.category = 'People (Venmo/Zelle/Cash App)'; continue; }
        // a credit from a merchant this account paid recently = a refund
        const prior = all.find(o => o.amount < 0 && o.key === t.key && o.date <= t.date && days(o.date, t.date) <= 120);
        if (prior && !RX.transferish.test(up)) { t.counts = 'offset'; t.category = prior.category || categorize(prior); t.refund = true; continue; }
        t.counts = 'unknown_in'; t.review = 'in'; t.source = t.name;
      }
    }

    // 4. apply the person's answers
    for (const t of all) {
      if (t.counts === 'unknown_in' || (t.review === 'in')) {
        const ch = PAYER_CHOICES[prefs.payers[t.key]];
        if (ch) {
          t.answered = prefs.payers[t.key];
          t.counts = ch.counts === 'withdrawal' ? 'withdrawal' : ch.counts;
          if (ch.counts === 'income') { t.incomeType = prefs.payers[t.key]; t.source = t.name; }
          if (ch.counts === 'offset') t.category = 'Other';
          if (ch.counts === 'internal') t.category = 'Transfer between my accounts';
        }
      }
      if (t.review === 'out' || t.review === 'card') {
        const ch = OUT_CHOICES[prefs.outs[t.key]];
        if (ch) { t.answered = prefs.outs[t.key]; t.counts = ch.counts; if (ch.category) t.category = ch.category; if (ch.counts === 'internal') t.category = 'Transfer between my accounts'; if (ch.counts === 'saving') t.category = 'Savings & investing'; }
      }
      if ((t.counts === 'spend' || t.counts === 'offset') && prefs.merchants[t.key]) t.category = prefs.merchants[t.key];
      const ov = prefs.txns[t.id];
      if (ov) { if (ov.counts) t.counts = ov.counts; if (ov.category) t.category = ov.category; }
    }

    // 5. what it found
    // pay stubs: tie each net pay to its bank deposit (naming the payer), and add up the year so far
    const pay = paySummary(files.map(f => f.result).filter(r => r && r.kind === 'paystub'), all, stmts, wStart, wEnd);

    const start = wStart, end = wEnd;
    const months = {};
    const month = d => d.slice(0, 7);
    const M = k => months[k] || (months[k] = { month: k, income: 0, spend: 0, saving: 0 });
    let income = 0, spend = 0, saving = 0, withdrawn = 0, internalN = 0, pendingIn = 0, pendingOut = 0, investIncome = 0;
    const byCat = {}, bySource = {}, byMerchant = {}, byAccount = {};
    // each investment account: what went in and out, what it earned, what it cost
    const invest = {};
    let payrollEmployee = 0, payrollEmployer = 0;
    const newInv =(name, date) => invest[name] || (invest[name] = { account: name, first: date, last: date, n: 0, deposits: 0, withdrawals: 0, moved: 0,
      dividend: 0, interest: 0, match: 0, fee: 0, premium_in: 0, premium_out: 0, trade: 0, years: {}, statements: [] });
    for (const s of stmts.sort((a, b) => a.start < b.start ? -1 : 1)) {
      const a = newInv(s.account, s.start);
      a.type = s.accountType; a.broker = s.broker; a.last4 = s.last4;
      if (s.start < a.first) a.first = s.start;
      if (s.end > a.last) a.last = s.end;
      a.statements.push({ start: s.start, end: s.end, open: s.open, close: s.close, cash: s.cashClose, dividends: s.dividends, contributions: s.contributions, file: s.fileName,
        plan: !!s.plan, employee: s.employee, employer: s.employer, fees: s.fees, market: s.market, withdrawals: s.withdrawals, rothShare: s.rothShare });
      if (s.plan) {
        a.plan = true;
        // the share of this statement's payroll contributions that falls inside the household window
        const ov = Math.max(0, days(s.start > wStart ? s.start : wStart, s.end < wEnd ? s.end : wEnd) + 1) / Math.max(1, days(s.start, s.end) + 1);
        payrollEmployee += (s.employee || 0) * ov; payrollEmployer += (s.employer || 0) * ov;
      }
      if (!accounts[s.account]) accounts[s.account] = { name: s.account, orig: s.origAccount, type: 'invest', issuer: s.broker.toLowerCase(), count: 0, first: s.start, last: s.end, files: new Set() };
      accounts[s.account].files.add(s.fileName);
      if (s.start < accounts[s.account].first) accounts[s.account].first = s.start;
      if (s.end > accounts[s.account].last) accounts[s.account].last = s.end;
      accounts[s.account].statements = (accounts[s.account].statements || 0) + 1;
    }
    for (const t of all) {
      if (t.accountType !== 'invest') continue;
      const a = newInv(t.account, t.date);
      if (!a.txFirst || t.date < a.txFirst) a.txFirst = t.date;
      if (!a.txLast || t.date > a.txLast) a.txLast = t.date;
      if (t.date < a.first) a.first = t.date;
      if (t.date > a.last) a.last = t.date;
      a.n++;
      const k = t.invKind, v = t.amount;
      if (k === 'deposit') a.deposits += v; else if (k === 'withdrawal') a.withdrawals -= v; else if (k === 'fee') a.fee -= v; else a[k] += v;
      if (['dividend', 'interest', 'match', 'fee'].includes(k)) {
        const y = a.years[t.date.slice(0, 4)] || (a.years[t.date.slice(0, 4)] = { year: t.date.slice(0, 4), earned: 0, fees: 0 });
        if (k === 'fee') y.fees -= v; else y.earned += v;
        if (t.inWindow && k !== 'fee') investIncome += v;
      }
    }
    for (const t of all) {
      if (!t.inWindow) continue;
      const mm = M(month(t.date));
      const acc = byAccount[t.account] || (byAccount[t.account] = { spend: 0, income: 0 });
      if (t.counts === 'income') {
        income += t.amount; mm.income += t.amount; acc.income += t.amount;
        const s = bySource[t.source] || (bySource[t.source] = { source: t.source, type: t.incomeType, total: 0, n: 0, last: t.date });
        s.total += t.amount; s.n++; s.last = t.date;
      } else if (t.counts === 'spend' || t.counts === 'offset') {
        const v = -t.amount;
        spend += v; mm.spend += v; acc.spend += v;
        byCat[t.category] = (byCat[t.category] || 0) + v;
        if (t.counts === 'spend') {
          const m = byMerchant[t.key] || (byMerchant[t.key] = { key: t.key, name: t.name, total: 0, n: 0, category: t.category });
          m.total += v; m.n++;
        }
      } else if (t.counts === 'saving') { saving += Math.abs(t.amount); mm.saving += Math.abs(t.amount); }
      else if (t.counts === 'withdrawal') { withdrawn += Math.abs(t.amount); mm.saving -= Math.abs(t.amount); }
      else if (t.counts === 'internal') internalN++;
      else if (t.counts === 'unknown_in') pendingIn += t.amount;
      else if (t.counts === 'unknown_out') pendingOut -= t.amount;
    }
    saving -= withdrawn;
    // from pay stubs: stock purchase plan and HSA always; 401(k) only when no plan statement already counts it
    let payStock = 0;
    for (const p of pay || []) {
      payStock += p.stockInWindow + p.hsaInWindow;
      if (!p.planLoaded) { payrollEmployee += p.retireInWindow; payrollEmployer += p.matchInWindow; }
    }

    // review lists, grouped by sender so each is answered once
    const group = (rows, sign) => {
      const g = {};
      for (const t of rows) {
        const x = g[t.key] || (g[t.key] = { key: t.key, name: t.name, example: t.desc, account: t.account, n: 0, total: 0, first: t.date, last: t.date, answer: t.answered || '' });
        x.n++; x.total += sign * t.amount; x.last = t.date;
      }
      return Object.values(g).map(x => Object.assign(x, { total: r2(x.total), cadence: cadenceOf(rows.filter(t => t.key === x.key).map(t => t.date)) }))
        .sort((a, b) => b.total - a.total);
    };
    const review = {
      deposits: group(all.filter(t => t.review === 'in'), 1),
      sentOut: group(all.filter(t => t.review === 'out'), -1),
      cardsNotLoaded: group(all.filter(t => t.review === 'card'), -1),
      checks: all.filter(t => t.review === 'check').map(t => ({ id: t.id, date: t.date, desc: t.desc, amount: -t.amount, account: t.account })),
    };

    return {
      start, end, accounts: Object.values(accounts).map(a => Object.assign(a, { files: [...a.files] })),
      txns: all,
      totals: {
        income: r2(income), spend: r2(spend), saving: r2(saving), net: r2(income - spend),
        savingsRate: income > 0 ? (income - spend) / income : null,
        internalCount: internalN, pendingIn: r2(pendingIn), pendingOut: r2(pendingOut), investIncome: r2(investIncome),
        payrollEmployee: r2(payrollEmployee), payrollEmployer: r2(payrollEmployer), payStock: r2(payStock),
        monthsCovered: start ? Math.max(1, days(start, end) / 30.44) : 0,
      },
      months: Object.values(months).sort((a, b) => a.month < b.month ? -1 : 1).map(m => ({ month: m.month, income: r2(m.income), spend: r2(m.spend), saving: r2(m.saving), partial: m.month === month(start) && start.slice(8) > '05' || m.month === month(end) && end.slice(8) < '25' })),
      categories: Object.entries(byCat).map(([category, total]) => ({ category, total: r2(total) })).sort((a, b) => b.total - a.total),
      income: Object.values(bySource).map(s => Object.assign(s, { total: r2(s.total), cadence: cadenceOf(all.filter(t => t.counts === 'income' && t.source === s.source).map(t => t.date)) })).sort((a, b) => b.total - a.total),
      merchants: Object.values(byMerchant).map(m => Object.assign(m, { total: r2(m.total) })).sort((a, b) => b.total - a.total),
      byAccount,
      investments: Object.values(invest).map(a => {
        for (const k of ['deposits', 'withdrawals', 'moved', 'dividend', 'interest', 'match', 'fee', 'premium_in', 'premium_out', 'trade']) a[k] = r2(a[k]);
        a.years = Object.values(a.years).sort((x, y) => x.year < y.year ? 1 : -1).map(y => ({ year: y.year, earned: r2(y.earned), fees: r2(y.fees) }));
        const st = a.statements.filter(s => s.close != null);
        if (st.length) {
          const last = st[st.length - 1];
          a.value = last.close; a.valueDate = last.end;
          const atStart = st.find(s => s.start <= wStart && s.end >= wStart) || st[0];
          a.startValue = atStart.open; a.startDate = atStart.start;
          if (a.plan) {
            const inRange = st.filter(s => s.start >= a.startDate && s.end <= a.valueDate);
            a.planAdded = r2(inRange.reduce((x, s) => x + (s.employee || 0) + (s.employer || 0) - (s.withdrawals || 0), 0));
            a.planEmployee = r2(inRange.reduce((x, s) => x + (s.employee || 0), 0));
            a.planEmployer = r2(inRange.reduce((x, s) => x + (s.employer || 0), 0));
            a.planFees = r2(inRange.reduce((x, s) => x + (s.fees || 0), 0));
            a.planDays = Math.max(1, days(a.startDate, a.valueDate));
            a.rothShare = last.rothShare != null ? last.rothShare : null;
          }
          a.statementDividends = r2(st.filter(s => s.start >= wStart && s.end <= wEnd).reduce((x, s) => x + (s.dividends || 0), 0));
          const have = new Set(st.map(s => s.start.slice(0, 7)));
          a.missingMonths = [];
          for (let d = new Date(st[0].start + 'T12:00:00Z'); d.toISOString().slice(0, 7) <= last.start.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) {
            const k = d.toISOString().slice(0, 7);
            if (!have.has(k)) a.missingMonths.push(k);
          }
        }
        a.exports = Object.keys(invName).filter(f => ((prefs.accounts[invName[f]] || {}).name || invName[f]) === a.account).length;
        return a;
      }).sort((x, y) => x.last < y.last ? 1 : -1),
      recurring: findRecurring(all, end),
      doubles: findDoubles(all),
      fees: all.filter(t => t.counts === 'spend' && t.category === 'Fees & interest').map(t => ({ date: t.date, desc: t.desc, amount: -t.amount, account: t.account })),
      refunds: all.filter(t => t.refund && t.counts === 'offset').map(t => ({ date: t.date, desc: t.desc, amount: t.amount, account: t.account })),
      transfers: transferMap(all),
      copies, pay, mortgages: files.map(f => f.result).filter(r => r && r.kind === 'f1098').sort((a, b) => (b.year || 0) - (a.year || 0)).filter((m, i, a) => a.findIndex(x => x.lender === m.lender && x.property === m.property) === i),
      ras: files.map(f => f.result).filter(r => r && r.kind === 'ras').sort((a, b) => (a.asOf || '') < (b.asOf || '') ? 1 : -1)[0] || null,
      r1099s: files.map(f => f.result).filter(r => r && r.kind === 'r1099').filter((w, i, a) => a.findIndex(x => x.year === w.year && x.payer === w.payer && x.gross === w.gross) === i).sort((a, b) => (b.year || 0) - (a.year || 0)),
      w2s: files.map(f => f.result).filter(r => r && r.kind === 'w2').filter((w, i, a) => a.findIndex(x => x.year === w.year && x.employer === w.employer && x.wages === w.wages) === i).sort((a, b) => (b.year || 0) - (a.year || 0)), ssa: files.map(f => f.result).filter(r => r && r.kind === 'ssa').sort((a, b) => (a.asOf || '') < (b.asOf || '') ? 1 : -1)[0] || null,
      duplicatesRemoved: dupes.map(d => ({ date: d.dropped.date, desc: d.dropped.desc, amount: d.dropped.amount, account: d.dropped.account, file: d.dropped.file, keptFrom: d.kept.file })),
      review,
    };
  }

  /* One summary per employer from its newest stub's year-to-date figures, scaled to a full year. Net pays found in a
     bank file become that employer's paycheck. Stock purchase plans (and retirement deductions when no plan statement
     is loaded) are investing the bank never sees, so they're returned for the Invested total. */
  function paySummary(stubs, all, stmts, wStart, wEnd) {
    if (!stubs.length) return null;
    const out = [];
    const byEmp = {};
    for (const s of stubs) (byEmp[s.employer] = byEmp[s.employer] || []).push(s);
    for (const [employer, list0] of Object.entries(byEmp)) {
      const list = list0.filter((s, i, a) => a.findIndex(x => x.payDate === s.payDate && x.current.net === s.current.net) === i).sort((a, b) => a.payDate < b.payDate ? -1 : 1);
      const last = list[list.length - 1], year = (last.end || last.payDate).slice(0, 4);
      const ytdDays = days(year + '-01-01', last.end || last.payDate) + 1, scale = 365 / Math.max(30, ytdDays);
      const sum = (rows, kind) => r2(rows.filter(l => !kind || l.kind === kind).reduce((x, l) => x + l.ytd, 0));
      const found = [];
      for (const s of list) {
        const amt = s.deposits.length ? s.deposits : [{ amount: s.current.net }];
        for (const d of amt) {
          const t = all.find(t => t.accountType !== 'invest' && Math.abs(t.amount - d.amount) < 0.01 && days(s.payDate, t.date) >= -5 && days(s.payDate, t.date) <= 5);
          if (!t) continue;
          found.push({ payDate: s.payDate, amount: d.amount, account: t.account, date: t.date });
          if (t.counts === 'unknown_in' || t.counts === 'income') { t.counts = 'income'; t.incomeType = 'paycheck'; t.source = employer + ' pay'; t.review = null; }
        }
      }
      const y = last.ytd || {};
      const lines = { taxes: last.taxes, before: last.before, after: last.after, employer: last.employerPaid };
      const stockYtd = sum(last.before, 'stock') + sum(last.after, 'stock');
      const retireYtd = sum(last.before, 'retire') + sum(last.after, 'retire'), matchYtd = sum(last.employerPaid, 'retire');
      const hsaYtd = sum(last.before, 'hsa') + sum(last.after, 'hsa');
      const fed = sum(last.taxes.filter(l => /fed(eral)?\b.*(withh|income)|^fed withholding|FIT/i.test(l.name)));
      // the share of a year that the household window covers, for adding a yearly pace to Invested
      const winYears = wStart && wEnd ? (days(wStart, wEnd) + 1) / 365 : 1;
      out.push({ employer, stubs: list.map(s => ({ payDate: s.payDate, begin: s.begin, end: s.end, gross: s.current.gross, net: s.current.net, file: s.fileName })),
        ytdThrough: last.end || last.payDate, ytdDays, scale, ytd: y, current: last.current, lines, found, w4: last.w4, payCount: list.length, les: !!last.les, allowances: last.allowances || [], grade: last.grade || null,
        stockYtd: r2(stockYtd), retireYtd: r2(retireYtd), matchYtd: r2(matchYtd), hsaYtd: r2(hsaYtd), fedWithheldYtd: fed,
        planLoaded: stmts.some(s => s.plan), stockInWindow: r2(stockYtd * scale * winYears),
        retireInWindow: r2(retireYtd * scale * winYears), matchInWindow: r2(matchYtd * scale * winYears), hsaInWindow: r2(hsaYtd * scale * winYears) });
    }
    return out;
  }

  // ---------- money between the person's own accounts: who sent what to whom ----------
  function transferMap(all) {
    const flows = {};
    const add = (from, to, t, how) => {
      const k = from + '→' + to;
      const x = flows[k] || (flows[k] = { from, to, how, n: 0, total: 0, first: t.date, last: t.date });
      x.n++; x.total += Math.abs(t.amount); x.last = t.date;
    };
    for (const t of all) {
      if (!t.inWindow) continue;
      if (t.pair && t.amount < 0) {
        const how = t.pair.accountType === 'card' ? 'card payment' : t.pair.accountType === 'invest' || t.accountType === 'invest' ? 'investing' : 'transfer';
        add(t.account, t.pair.account, t, how);
        t.otherSide = t.pair.account; t.pair.otherSide = t.account;
      } else if (t.counts === 'internal' && !t.pair) {
        // one side only: a card payment whose card file has no payment line, or a transfer the person said was their own
        if (t.amount < 0) { add(t.account, t.otherCard ? t.otherCard + ' (its file lists no payments)' : 'an account not loaded', t, 'one side'); if (t.otherCard) t.otherSide = t.otherCard; }
        else add(t.category === 'Card payment' ? 'a bank account not loaded' : 'an account not loaded', t.account, t, 'one side');
      }
    }
    return Object.values(flows).map(x => Object.assign(x, { total: r2(x.total) })).sort((a, b) => (a.how === 'one side') - (b.how === 'one side') || b.total - a.total);
  }

  // ---------- recurring charges ----------
  const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
  const CADENCES = [['weekly', 7, 5, 9], ['every 2 weeks', 14, 12, 17], ['twice a month', 15.2, 13, 18], ['monthly', 30.4, 25, 36], ['every 3 months', 91, 80, 100], ['every 6 months', 182, 165, 200], ['yearly', 365, 340, 390]];
  function cadenceOf(dates) {
    if (dates.length < 2) return '';
    const gaps = [];
    for (let i = 1; i < dates.length; i++) { const g = days(dates[i - 1], dates[i]); if (g > 0) gaps.push(g); }
    if (!gaps.length) return '';
    const g = median(gaps);
    const c = CADENCES.find(([, , lo, hi]) => g >= lo && g <= hi);
    return c ? c[0] : '';
  }
  const usd = n => '$' + n.toFixed(2);
  function findRecurring(all, end) {
    const groups = {};
    for (const t of all) {
      if (t.counts !== 'spend' || t.amount >= 0) continue;
      if (['Checks', 'Cash & ATM', 'People (Venmo/Zelle/Cash App)', 'Card payments (card not loaded)', 'Groceries', 'Dining out', 'Auto & gas', 'Buy now, pay later'].includes(t.category)) continue;
      (groups[t.key] || (groups[t.key] = [])).push(t);
    }
    const out = [], found = new Set();
    for (const [key, rows] of Object.entries(groups)) {
      // a merchant with mixed amounts (Apple, Amazon) may still hide one steady charge: split by amount
      const byAmt = {};
      for (const t of rows) (byAmt[t.amount.toFixed(2)] || (byAmt[t.amount.toFixed(2)] = [])).push(t);
      for (const [a, sub] of Object.entries(byAmt)) if (sub.length >= 3 && sub.length < rows.length) groups[key + ' · ' + a] = sub;
    }
    for (const [key, rows0] of Object.entries(groups)) {
      const base = key.split(' · ')[0];
      if (key !== base && found.has(base)) continue;
      // one charge per day in a series (a burst of same-day buys is not a schedule)
      const rows = rows0.filter((t, i) => !i || t.date !== rows0[i - 1].date);
      if (rows.length < 2) continue;
      const amts = rows.map(t => -t.amount), med = median(amts);
      const steady = amts.filter(a => Math.abs(a - med) <= Math.max(1, med * 0.2)).length / amts.length;
      if (steady < 0.75) continue;
      const dates = rows.map(t => t.date);
      const cad = cadenceOf(dates);
      if (!cad) continue;
      const def = CADENCES.find(c => c[0] === cad);
      if (rows.length < (def[1] >= 300 ? 2 : def[1] >= 80 ? 2 : 3)) continue;
      // the gaps themselves have to be regular, not just their median
      const gaps = []; for (let i = 1; i < dates.length; i++) gaps.push(days(dates[i - 1], dates[i]));
      const regular = gaps.filter(g => g >= def[2] && g <= def[3]).length / gaps.length;
      if (regular < 0.6) continue;
      const last = rows[rows.length - 1];
      const lastAmt = -last.amount;
      const earlier = median(amts.slice(0, -1));
      const perYear = med * 365 / def[1];
      const next = new Date(Date.parse(last.date) + def[1] * 86400000).toISOString().slice(0, 10);
      const active = days(last.date, end) <= def[1] * 1.6;
      if (key === base) found.add(base);
      out.push({
        key, name: last.name + (key !== base ? ' (' + usd(lastAmt) + ')' : ''), category: last.category, account: last.account, cadence: cad, n: rows.length,
        typical: r2(med), last: r2(lastAmt), lastDate: last.date, next: active ? next : '', perYear: r2(perYear), active,
        priceUp: lastAmt > earlier * 1.03 && lastAmt - earlier >= 0.5 ? r2(lastAmt - earlier) : 0,
        kind: ['Housing', 'Loans', 'Utilities & phone', 'Insurance', 'Taxes'].includes(last.category) ? 'bill' : 'subscription',
      });
    }
    return out.sort((a, b) => (b.active - a.active) || (b.perYear - a.perYear));
  }

  // same merchant, same amount, same account, within a day: possibly charged twice (one entry per burst)
  function findDoubles(all) {
    const out = [];
    const skip = ['Subscriptions', 'Housing', 'Loans', 'Checks', 'Card payments (card not loaded)', 'Dining out', 'People (Venmo/Zelle/Cash App)', 'Cash & ATM'];
    const rows = all.filter(t => t.counts === 'spend' && t.amount <= -10 && !skip.includes(t.category));
    const by = {};
    for (const t of rows) { const k = t.account + '|' + t.key + '|' + t.amount.toFixed(2); (by[k] || (by[k] = [])).push(t); }
    for (const g of Object.values(by)) {
      let burst = [g[0]];
      const flush = () => {
        if (burst.length > 1) out.push({ name: burst[0].name, amount: -burst[0].amount, account: burst[0].account, count: burst.length,
          dates: [burst[0].date, burst[burst.length - 1].date], ids: burst.map(t => t.id) });
      };
      for (let i = 1; i < g.length; i++) {
        if (days(burst[burst.length - 1].date, g[i].date) <= 1) burst.push(g[i]); else { flush(); burst = [g[i]]; }
      }
      flush();
    }
    return out.sort((x, y) => y.amount * y.count - x.amount * x.count);
  }

  // ---------- export ----------
  function toCSV(result) {
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const COUNTS = { income: 'Income', spend: 'Spending', offset: 'Refund / credit', saving: 'Saved / invested', withdrawal: 'Taken from investments', internal: 'Between my accounts', inv: 'Inside an investment account', unknown_in: 'Deposit (not identified)', unknown_out: 'Sent out (not identified)', ignore: 'Ignored' };
    const lines = [['Date', 'Account', 'Description', 'Merchant / payer', 'Amount', 'Counts as', 'Category', 'Income source', 'Original category', 'File'].join(',')];
    for (const t of result.txns) {
      lines.push([t.date, t.account, t.desc, t.name, t.amount.toFixed(2), COUNTS[t.counts] || t.counts, t.counts === 'income' ? '' : t.category || '', t.counts === 'income' ? t.source : '', t.srcCat, t.file].map(esc).join(','));
    }
    return lines.join('\r\n');
  }

  const api = { parseCSV, parseFile, parseStatement, analyze, toCSV, merchantOf, cleanDesc, toDate, money, cadenceOf, CATEGORIES, PAYER_CHOICES, OUT_CHOICES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FireMission = api;
})(typeof window !== 'undefined' ? window : globalThis);
