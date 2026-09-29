// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2024–2026 Lionsville Group BV
//
// Port of core's businessCase.test.ts: the arithmetic, against the workbook it was designed
// down from. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBusinessCase, internalRateOfReturn, netPresentValue, readAmount, readBusinessCase,
} from '../ui/plugins/business-case.js';

const WORKBOOK = `
currency: EUR
discount rate: 10%

| Line          | Year 0    | Year 1 | Year 2  | Year 3  | Year 4  | Year 5  |
| ------------- | --------- | ------ | ------- | ------- | ------- | ------- |
| Investment    | -415 000  |        |         |         |         |         |
| Cost savings  |           | 25 000 | 125 000 | 125 000 | 125 000 | 125 000 |
| Revenue gains |           |        |  50 000 | 150 000 | 150 000 | 150 000 |
`;
const read = (source) => computeBusinessCase(readBusinessCase(source));
const close = (a, b, digits) => assert.ok(Math.abs(a - b) < 10 ** -digits / 2, `${a} ≉ ${b}`);

test('readAmount', () => {
  assert.equal(readAmount('415000'), 415000);
  assert.equal(readAmount('-415000'), -415000);
  assert.equal(readAmount(''), 0);
  assert.equal(readAmount('415 000'), 415000);
  assert.equal(readAmount('€ 415 000'), 415000);
  assert.equal(readAmount('  -415 000  '), -415000);
  assert.equal(readAmount('(415 000)'), -415000);
  assert.equal(readAmount('1.200'), 1200);
  assert.equal(readAmount('1,200'), 1200);
  assert.equal(readAmount('1.5'), 1.5);
  assert.equal(readAmount('1,5'), 1.5);
  assert.equal(readAmount('0.10'), 0.1);
  close(readAmount('1.234,56'), 1234.56, 6);
  close(readAmount('1,234.56'), 1234.56, 6);
  close(readAmount('1 234 567,89'), 1234567.89, 6);
  assert.equal(readAmount('n/a'), undefined);
  assert.equal(readAmount('—'), undefined);
});

test('readBusinessCase', () => {
  const held = readBusinessCase(WORKBOOK);
  assert.equal(held.currency, 'EUR');
  assert.equal(held.discountRate, 0.1);
  assert.deepEqual(held.periods, ['Year 0', 'Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5']);
  assert.deepEqual(held.lines[0].amounts, [-415000, 0, 0, 0, 0, 0]);
  assert.deepEqual(held.lines[1].amounts, [0, 25000, 125000, 125000, 125000, 125000]);
  close(readBusinessCase('discount rate: 0.08').discountRate, 0.08, 6);
  close(readBusinessCase('discount rate: 8 %').discountRate, 0.08, 6);
  const scored = readBusinessCase(`${WORKBOOK}
| Criterion               | Weight | Score |
| ----------------------- | ------ | ----- |
| Alignment with strategy | 3      | 4     |
| Risk reduction          | 2      | 2     |
`);
  assert.deepEqual(scored.criteria, [
    { name: 'Alignment with strategy', weight: 3, score: 4 },
    { name: 'Risk reduction', weight: 2, score: 2 },
  ]);
  assert.equal(scored.lines.length, 3);
  assert.deepEqual(readBusinessCase('horizon: 5 years\ncurrency: EUR').extra, { horizon: '5 years' });
  const half = readBusinessCase('| Line | Year 0 |\n| --- | --- |\n| Spend | -100 |');
  assert.equal(half.discountRate, undefined);
  assert.deepEqual(half.lines[0].amounts, [-100]);
  assert.deepEqual(readBusinessCase('').lines, []);
});

test('computeBusinessCase', () => {
  const result = read(WORKBOOK);
  assert.deepEqual(result.net, [-415000, 25000, 175000, 275000, 275000, 275000]);
  assert.deepEqual(result.cumulative, [-415000, -390000, -215000, 60000, 335000, 610000]);
  assert.equal(result.totalIn, 1025000);
  assert.equal(result.totalOut, 415000);
  close(result.npv, 317549.01, 2); // period 0 undiscounted (Excel's NPV gives 288,680.91)
  close(result.irr, 0.3031809549, 8);
  close(result.payback, 2.7818181818, 8);
  close(result.roi, 1.4698795181, 8);
  close(result.ratio, 2.4698795181, 8);
  const noRate = read(WORKBOOK.replace('discount rate: 10%', ''));
  assert.equal(noRate.npv, undefined);
  assert.notEqual(noRate.irr, undefined);
  assert.equal(internalRateOfReturn([-100, -100, -100]), undefined);
  assert.equal(internalRateOfReturn([100, 100]), undefined);
  assert.equal(internalRateOfReturn([]), undefined);
  const net = [-1000, 400, 400, 400];
  close(netPresentValue(net, internalRateOfReturn(net)), 0, 6);
  assert.equal(read('| Line | Y0 | Y1 |\n| --- | --- | --- |\n| Spend | -100 | -100 |').payback, undefined);
  assert.equal(read('| Line | Y0 | Y1 |\n| --- | --- | --- |\n| Gain | 100 | 100 |').payback, 0);
  const gain = read('| Line | Y0 |\n| --- | --- |\n| Gain | 100 |');
  assert.equal(gain.roi, undefined);
  assert.equal(gain.ratio, undefined);
  assert.deepEqual(read(`${WORKBOOK}
| Criterion | Weight | Score |
| --- | --- | --- |
| Alignment | 3 | 4 |
| Risk      | 2 | 2 |
`).score, { total: 16, max: 25, scale: 5 });
  assert.deepEqual(read(`${WORKBOOK}
| Criterion | Weight | Score |
| --- | --- | --- |
| Counts | 2 | 4 |
| Not yet weighted |  | 5 |
`).score, { total: 8, max: 10, scale: 5 });
});
