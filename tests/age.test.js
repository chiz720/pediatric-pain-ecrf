import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, ageMonths, ageYears, ageLabel, toDate } from '../lib/age.js';

test('ageDays counts whole days across a leap year', () => {
  assert.equal(ageDays('2020-01-01', '2021-01-01'), 366);
  assert.equal(ageDays('2021-01-01', '2022-01-01'), 365);
});

test('ageYears is calendar-correct on the birthday, not on a day count', () => {
  // Born before a leap day: the 4th birthday lands at 1461 days.
  assert.equal(ageDays('2022-01-10', '2026-01-10'), 1461);
  assert.equal(ageYears('2022-01-10', '2026-01-09'), 3);
  assert.equal(ageYears('2022-01-10', '2026-01-10'), 4);

  // Born after the leap day: the 4th birthday lands at 1460 days.
  assert.equal(ageDays('2022-03-10', '2026-03-10'), 1461);
  assert.equal(ageYears('2023-03-10', '2027-03-09'), 3);
  assert.equal(ageYears('2023-03-10', '2027-03-10'), 4);
});

test('day counts are not stable for the boundaries this protocol actually uses', () => {
  // Four- and eight-year spans always contain exactly one and two leap days, so
  // the FLACC/FPS-R and FPS-R/NRS boundaries would in fact be stable as day
  // counts. The other protocol boundaries are not.

  // Seven years — the assent boundary — is 2556 or 2557 days.
  assert.equal(ageDays('2017-01-01', '2024-01-01'), 2556);
  assert.equal(ageDays('2018-01-01', '2025-01-01'), 2557);
  assert.equal(ageYears('2017-01-01', '2024-01-01'), 7);
  assert.equal(ageYears('2018-01-01', '2025-01-01'), 7);

  // One and three years — respiratory-rate bands — likewise vary.
  assert.equal(ageDays('2023-01-01', '2024-01-01'), 365);
  assert.equal(ageDays('2024-01-01', '2025-01-01'), 366);

  // Eighteen years — the enrolment ceiling — is 6574 or 6575.
  assert.equal(ageDays('2006-01-01', '2024-01-01'), 6574);
  assert.equal(ageDays('2007-01-01', '2025-01-01'), 6575);

  // Six completed months — the local anaesthetic reduction — is 181 or 182.
  assert.equal(ageDays('2025-01-01', '2025-07-01'), 181);
  assert.equal(ageDays('2024-01-01', '2024-07-01'), 182);
  assert.equal(ageMonths('2025-01-01', '2025-07-01'), 6);
  assert.equal(ageMonths('2024-01-01', '2024-07-01'), 6);
});

test('29 February birthdays advance on 1 March in common years', () => {
  assert.equal(ageYears('2020-02-29', '2025-02-28'), 4);
  assert.equal(ageYears('2020-02-29', '2025-03-01'), 5);
  assert.equal(ageYears('2020-02-29', '2024-02-29'), 4);
});

test('ageMonths does not round up before the day of the month', () => {
  assert.equal(ageMonths('2026-01-31', '2026-02-28'), 0);
  assert.equal(ageMonths('2026-01-15', '2026-02-14'), 0);
  assert.equal(ageMonths('2026-01-15', '2026-02-15'), 1);
});

test('ageLabel degrades sensibly for neonates and infants', () => {
  assert.equal(ageLabel('2026-09-01', '2026-09-19'), '18 d');
  assert.equal(ageLabel('2026-02-01', '2026-09-11'), '7 m');
  assert.equal(ageLabel('2022-07-11', '2026-09-11'), '4 y 2 m');
});

test('impossible calendar dates are rejected, not silently rolled over', () => {
  assert.throws(() => toDate({ year: 2026, month: 2, day: 30 }), /Not a real calendar date/);
  assert.throws(() => toDate({ year: 2026, month: 13, day: 1 }), /Month out of range/);
  assert.throws(() => toDate('not-a-date'), /Unparseable/);
});
