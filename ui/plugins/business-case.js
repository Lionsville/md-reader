// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2024–2026 Lionsville Group BV

/**
 * Built-in plugin: a ```business-case fence, computed (ADR-0009).
 *
 * Ported from Lionsville Architecture (core: src/documentation/businessCase.ts and
 * ui/BusinessCaseBlock.tsx). The reading and the arithmetic are the same code, line
 * for line; only the rendering moved from React/MUI to plain DOM. Keep the two in
 * step: the format is a contract — a block written in one must read the same here.
 *
 * ```business-case
 * currency: EUR
 * discount rate: 10%
 *
 * | Line       | Year 0   | Year 1 | Year 2  |
 * | ---------- | -------- | ------ | ------- |
 * | Investment | -415 000 |        |         |
 * | Savings    |          | 25 000 | 125 000 |
 *
 * | Criterion               | Weight | Score |
 * | ----------------------- | ------ | ----- |
 * | Alignment with strategy | 3      | 4     |
 * ```
 *
 * Keys first, then the first table is the money and the second is the scorecard.
 * The first column names a line, the rest are periods; negative is money out,
 * positive is money in, a blank cell is zero. The keys are English and stay English
 * — the fence's contents are a format; what is rendered around it is translated.
 *
 * A block that cannot be read renders as its own source: a block that fails must
 * never take its text with it.
 */

/** The one to five a criterion is scored on. Named, because the reader is told. */
export const SCORE_SCALE = 5;

// --- reading ----------------------------------------------------------------

/**
 * A number as a person writes one: `1 200`, `1.200`, `€ -1,200.50`, `(1200)`.
 * A single separator with exactly three digits after it groups thousands, anything
 * else is a decimal point. With both present, the last one is the decimal.
 * @returns {number|undefined}
 */
export function readAmount(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const negative = /^\(.*\)$/.test(trimmed);
  let cleaned = trimmed.replace(/[()]/g, '').replace(/[^\d.,+-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return undefined;
  const sign = cleaned.startsWith('-') || negative ? -1 : 1;
  cleaned = cleaned.replace(/[+-]/g, '');

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let decimal = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const only = Math.max(lastDot, lastComma);
    const after = cleaned.length - only - 1;
    const separators = (cleaned.match(/[.,]/g) ?? []).length;
    // One separator, three digits after it, and digits before it: thousands.
    if (!(separators > 1 || (after === 3 && only > 0))) decimal = only;
  }
  const digits = decimal >= 0
    ? `${cleaned.slice(0, decimal).replace(/[.,]/g, '')}.${cleaned.slice(decimal + 1).replace(/[.,]/g, '')}`
    : cleaned.replace(/[.,]/g, '');
  const value = Number(digits);
  return Number.isFinite(value) ? sign * value : undefined;
}

/** A rate as `10%`, `10 %` or `0.1`. */
function readRate(text) {
  const percent = text.includes('%');
  const value = readAmount(text);
  if (value === undefined) return undefined;
  return percent ? value / 100 : value;
}

/** The cells of one markdown table row, without the outer pipes. */
function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** Whether this row is the `|---|---|` rule under a table's heading. */
function isRule(row) {
  return cells(row).every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** Every markdown table in the text, in order. */
function tablesIn(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('|') || i + 1 >= lines.length || !isRule(lines[i + 1])) continue;
    const header = cells(lines[i]);
    const rows = [];
    let at = i + 2;
    while (at < lines.length && lines[at].includes('|') && lines[at].trim()) {
      rows.push(cells(lines[at]));
      at += 1;
    }
    tables.push({ header, rows });
    i = at - 1;
  }
  return tables;
}

/**
 * Read a block. Never throws and never refuses: a half-written case still shows
 * the half that reads.
 */
export function readBusinessCase(source) {
  const lines = source.split('\n');
  const extra = {};
  let currency;
  let discountRate;

  for (const line of lines) {
    if (line.includes('|')) break;
    const match = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, rawKey, value] = match;
    const key = rawKey.trim().toLowerCase();
    if (key === 'currency') currency = value.trim() || undefined;
    else if (key === 'discount rate') discountRate = readRate(value);
    else extra[key] = value.trim();
  }

  const tables = tablesIn(lines);
  const money = tables[0];
  const periods = money ? money.header.slice(1).map((name) => name.trim()) : [];
  const lineItems = (money?.rows ?? [])
    .filter((row) => row.length > 1 && row[0].trim())
    .map((row) => ({
      name: row[0].trim(),
      // Every line is the width of the header, so a short row is trailing zeros.
      amounts: periods.map((_period, at) => readAmount(row[at + 1] ?? '') ?? 0),
    }));

  const criteria = (tables[1]?.rows ?? [])
    .filter((row) => row.length >= 3 && row[0].trim())
    .map((row) => ({
      name: row[0].trim(),
      weight: readAmount(row[1]) ?? 0,
      score: readAmount(row[2]) ?? 0,
    }))
    .filter((criterion) => criterion.weight > 0);

  return { currency, discountRate, periods, lines: lineItems, criteria, extra };
}

// --- the arithmetic ---------------------------------------------------------

/** Net present value with period 0 undiscounted (unlike Excel's NPV). */
export function netPresentValue(net, rate) {
  return net.reduce((sum, amount, period) => sum + amount / (1 + rate) ** period, 0);
}

/** The rate at which the net present value is zero, by bisection. */
export function internalRateOfReturn(net) {
  if (!net.some((amount) => amount > 0) || !net.some((amount) => amount < 0)) return undefined;

  let low = -0.9999;
  let high = 1000;
  let atLow = netPresentValue(net, low);
  const atHigh = netPresentValue(net, high);
  if (!Number.isFinite(atLow) || !Number.isFinite(atHigh)) return undefined;
  if (atLow === 0) return low;
  if (atHigh === 0) return high;
  // A series that changes sign more than once may have several rates, or none here.
  if ((atLow > 0) === (atHigh > 0)) return undefined;
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    const value = netPresentValue(net, middle);
    if (value === 0 || high - low < 1e-9) return middle;
    if ((value > 0) === (atLow > 0)) { low = middle; atLow = value; } else high = middle;
  }
  return (low + high) / 2;
}

/** Everything the block says, from what it holds. */
export function computeBusinessCase(held) {
  const width = held.periods.length;
  const net = Array.from({ length: width }, (_unused, period) =>
    held.lines.reduce((sum, line) => sum + (line.amounts[period] ?? 0), 0));

  const cumulative = [];
  net.reduce((running, amount) => {
    const total = running + amount;
    cumulative.push(total);
    return total;
  }, 0);

  let totalIn = 0;
  let totalOut = 0;
  for (const line of held.lines) {
    for (const amount of line.amounts) {
      if (amount > 0) totalIn += amount;
      else totalOut -= amount;
    }
  }

  const result = { net, cumulative, totalIn, totalOut };

  if (held.discountRate !== undefined && width > 0) {
    result.npv = netPresentValue(net, held.discountRate);
  }
  if (width > 0) {
    const irr = internalRateOfReturn(net);
    if (irr !== undefined) result.irr = irr;
  }

  // The period the money is back, interpolated inside the period it crosses.
  const crossed = cumulative.findIndex((total) => total >= 0);
  if (crossed === 0) result.payback = 0;
  else if (crossed > 0) {
    const owed = -cumulative[crossed - 1];
    const flow = net[crossed];
    result.payback = flow > 0 ? crossed - 1 + owed / flow : crossed;
  }

  if (totalOut > 0) {
    result.roi = (totalIn - totalOut) / totalOut;
    result.ratio = totalIn / totalOut;
  }

  if (held.criteria.length) {
    result.score = {
      total: held.criteria.reduce((sum, one) => sum + one.weight * one.score, 0),
      max: held.criteria.reduce((sum, one) => sum + one.weight * SCORE_SCALE, 0),
      scale: SCORE_SCALE,
    };
  }

  return result;
}

// --- strings ----------------------------------------------------------------

const STRINGS = {
  en: {
    line: 'Line', net: 'Net', cumulative: 'Cumulative',
    npv: 'Net present value at {rate}', irr: 'Internal rate of return',
    payback: 'Payback, in periods', roi: 'Return on investment', ratio: 'Benefit-cost ratio',
    score: 'Weighted score {total} out of {max}, scored 1 to {scale}.',
    unreadable: 'This business case has no figures in it yet.',
  },
  nl: {
    line: 'Regel', net: 'Netto', cumulative: 'Cumulatief',
    npv: 'Netto contante waarde bij {rate}', irr: 'Interne rentabiliteit',
    payback: 'Terugverdientijd, in perioden', roi: 'Rendement op investering', ratio: 'Baten-kostenverhouding',
    score: 'Gewogen score {total} van {max}, beoordeeld van 1 tot {scale}.',
    unreadable: 'Deze business case bevat nog geen cijfers.',
  },
  de: {
    line: 'Zeile', net: 'Netto', cumulative: 'Kumuliert',
    npv: 'Kapitalwert bei {rate}', irr: 'Interner Zinsfuß',
    payback: 'Amortisation, in Perioden', roi: 'Kapitalrendite', ratio: 'Nutzen-Kosten-Verhältnis',
    score: 'Gewichtete Bewertung {total} von {max}, bewertet von 1 bis {scale}.',
    unreadable: 'Dieser Business Case enthält noch keine Zahlen.',
  },
};
const LOCALE = { en: 'en-GB', nl: 'nl-NL', de: 'de-DE' };

function language() {
  const lang = (globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
  return STRINGS[lang] ? lang : 'en';
}

function translate(lang, key, vars = {}) {
  return STRINGS[lang][key].replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
}

// --- formatting -------------------------------------------------------------

/** Money in the block's own currency where it named a code Intl knows; else printed beside it. */
function money(value, currency, locale) {
  const rounded = Math.round(value);
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0,
      }).format(rounded);
    } catch {
      // An unknown code: fall through and print it as a word.
    }
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(rounded);
  return currency ? `${currency} ${number}` : number;
}

function percent(value, locale) {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

function summaryFigures(result, held, locale, lang) {
  const figures = [];
  if (result.npv !== undefined) {
    figures.push({ id: 'npv', label: translate(lang, 'npv', { rate: percent(held.discountRate ?? 0, locale) }), value: money(result.npv, held.currency, locale) });
  }
  if (result.irr !== undefined) {
    figures.push({ id: 'irr', label: translate(lang, 'irr'), value: percent(result.irr, locale) });
  }
  if (result.payback !== undefined) {
    figures.push({ id: 'payback', label: translate(lang, 'payback'), value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(result.payback) });
  }
  if (result.roi !== undefined) {
    figures.push({ id: 'roi', label: translate(lang, 'roi'), value: percent(result.roi, locale) });
  }
  if (result.ratio !== undefined) {
    figures.push({ id: 'ratio', label: translate(lang, 'ratio'), value: `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(result.ratio)}×` });
  }
  return figures;
}

// --- rendering --------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function amountCell(amount, currency, locale, blankZero) {
  const td = el('td', amount < 0 ? 'bc-num bc-neg' : 'bc-num', blankZero && amount === 0 ? '' : money(amount, currency, locale));
  return td;
}

/** The block for one fence's source. */
export function renderBusinessCase(code) {
  const lang = language();
  const locale = LOCALE[lang];
  const held = readBusinessCase(code);
  const box = el('div', 'business-case');
  box.dataset.mdrSource = code;

  if (!held.lines.length) {
    box.dataset.state = 'unreadable';
    box.append(el('div', 'bc-caption', translate(lang, 'unreadable')));
    const pre = el('pre');
    pre.append(el('code', '', code));
    box.append(pre);
    return box;
  }
  box.dataset.state = 'computed';
  const result = computeBusinessCase(held);

  const wrap = el('div', 'bc-table');
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', '', translate(lang, 'line')));
  for (const period of held.periods) headRow.append(el('th', 'bc-num', period));
  head.append(headRow);

  const body = el('tbody');
  for (const line of held.lines) {
    const tr = el('tr');
    tr.append(el('td', '', line.name));
    for (const amount of line.amounts) tr.append(amountCell(amount, held.currency, locale, true));
    body.append(tr);
  }
  // Computed, and marked as such: a reader has to tell typed rows from worked-out ones.
  const netRow = el('tr', 'bc-net');
  netRow.append(el('td', '', translate(lang, 'net')));
  for (const amount of result.net) netRow.append(amountCell(amount, held.currency, locale, false));
  const cumRow = el('tr', 'bc-cumulative');
  cumRow.append(el('td', '', translate(lang, 'cumulative')));
  for (const amount of result.cumulative) cumRow.append(amountCell(amount, held.currency, locale, false));
  body.append(netRow, cumRow);
  table.append(head, body);
  wrap.append(table);
  box.append(wrap);

  const figures = el('div', 'bc-figures');
  for (const figure of summaryFigures(result, held, locale, lang)) {
    const f = el('div', 'bc-figure');
    f.dataset.figure = figure.id;
    f.append(el('div', 'bc-caption', figure.label), el('div', 'bc-value', figure.value));
    figures.append(f);
  }
  if (figures.childElementCount) box.append(figures);

  if (result.score) {
    const score = el('div', 'bc-score');
    // The scale and the maximum are said out loud: a weighted total means nothing without them.
    score.append(el('div', 'bc-caption', translate(lang, 'score', {
      total: String(result.score.total), max: String(result.score.max), scale: String(result.score.scale),
    })));
    const list = el('ul');
    for (const criterion of held.criteria) {
      list.append(el('li', '', `${criterion.name} — ${criterion.score} × ${criterion.weight}`));
    }
    score.append(list);
    box.append(score);
  }
  return box;
}

const SELECTOR = 'pre > code.language-business-case';

export default {
  id: 'business-case',
  name: 'Business case',
  description: 'Computes ```business-case blocks: net and cumulative cash flow, NPV, IRR, payback, ROI, benefit-cost ratio and a weighted scorecard.',
  version: '1.0.0',
  selector: SELECTOR,
  styles: `
.business-case{margin:.7em 0;font-variant-numeric:tabular-nums}
.business-case .bc-table{overflow-x:auto;border:1px solid var(--md-border,#d0d7de);border-radius:6px}
.markdown-body .business-case table{display:table;width:100%;margin:0;border:0;border-collapse:collapse;overflow:visible}
.markdown-body .business-case th,.markdown-body .business-case td{border:0;border-bottom:1px solid var(--md-border,#d0d7de);padding:6px 12px;white-space:nowrap;background:none}
.markdown-body .business-case th:first-child,.markdown-body .business-case td:first-child{white-space:normal;min-width:14em;text-align:left}
.markdown-body .business-case tr:last-child td{border-bottom:0}
.markdown-body .business-case thead th{font-weight:600;background:color-mix(in srgb,var(--md-link,#0969da) 7%,transparent)}
.markdown-body .business-case .bc-num{text-align:right}
.markdown-body .business-case .bc-neg{color:var(--md-caution,#cf222e)}
.markdown-body .business-case tr.bc-net td{font-weight:600;border-top:2px solid var(--md-border,#d0d7de);background:color-mix(in srgb,var(--md-link,#0969da) 4%,transparent)}
.markdown-body .business-case tr.bc-cumulative td:not(.bc-neg){color:var(--md-muted,#59636e)}
:root[data-theme="dark"] .markdown-body .business-case thead th{background:color-mix(in srgb,var(--md-link,#4493f8) 14%,transparent)}
:root[data-theme="dark"] .markdown-body .business-case tr.bc-net td{background:color-mix(in srgb,var(--md-link,#4493f8) 8%,transparent)}
.business-case .bc-figures{display:flex;flex-wrap:wrap;gap:20px;margin-top:10px}
.business-case .bc-caption{font-size:.8em;line-height:1.2;color:var(--md-muted,#59636e)}
.business-case .bc-value{font-weight:600;font-size:1.05em}
.business-case .bc-score{margin-top:10px}
.business-case .bc-score ul{margin:4px 0;padding-left:1.2em;color:var(--md-muted,#59636e);font-size:.9em}
.business-case[data-state="unreadable"] pre{margin:4px 0 0}
@media print{.business-case{break-inside:avoid}.business-case .bc-table{overflow:visible}.business-case *{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`,

  render(root, ctx) {
    for (const code of root.querySelectorAll(SELECTOR)) {
      if (!ctx.claim(code)) continue;
      const source = code.textContent.replace(/\n$/, '');
      const block = ctx.codeBlock(code) || code.closest('pre');
      block.replaceWith(renderBusinessCase(source));
    }
  },
};
