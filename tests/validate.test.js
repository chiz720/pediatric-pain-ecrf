import './_setup.js';
import { format as formatStudyNumber } from '../lib/studyNumber.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateItem, isVisible, validateSection, validateDateOfBirth, validateStudyNumberField,
  validateTimestampSequence, validateLocalAnaesthetic, validateNoDuplicateTimepoint,
  validateGatekeeper, warnImplausibleWeight, warnPainJump, warnDynamicBelowRest,
  warnRespiratoryDepression, warnPaedOutsidePacu, warnAldrete, warnEntryLag, summarise, BLOCK, WARN,
} from '../lib/validate.js';

const NOW = '2026-09-11T12:00:00Z';
const codes = (issues) => issues.map((i) => i.code);

test('a required field blocks, an optional empty one does not', () => {
  const item = { id: 'weight_kg', label: 'Weight', type: 'decimal', required: true, min: 0.5, max: 120 };
  assert.deepEqual(codes(validateItem(item, null)), ['required']);
  assert.deepEqual(codes(validateItem({ ...item, required: false }, null)), []);
  assert.deepEqual(codes(validateItem(item, 12)), []);
});

test('range violations block with a message naming the unit', () => {
  const item = { id: 'spo2', label: 'SpO2', type: 'integer', min: 50, max: 100, unit: '%' };
  assert.deepEqual(codes(validateItem(item, 105)), ['max']);
  assert.match(validateItem(item, 105)[0].message, /100 %/);
  assert.deepEqual(codes(validateItem(item, 44)), ['min']);
  assert.deepEqual(codes(validateItem(item, 96.5)), ['type']);
});

test('a hidden field is never required', () => {
  const section = {
    items: [
      { id: 'block_performed', label: 'Block performed', type: 'boolean', required: true },
      { id: 'la_agent', label: 'Agent', type: 'text', required: true, showIf: { field: 'block_performed', op: 'eq', value: true } },
    ],
  };
  assert.deepEqual(codes(validateSection(section, { block_performed: false })), []);
  assert.deepEqual(codes(validateSection(section, { block_performed: true })), ['required']);
});

test('showIf supports the operators the schema actually uses', () => {
  const rec = { a: 5, b: 'x', c: true, proposed_class: 'Nociception', adjudicated_class: 'Nociception' };
  assert.equal(isVisible({ showIf: { field: 'a', op: 'gte', value: 5 } }, rec), true);
  assert.equal(isVisible({ showIf: { field: 'b', op: 'in', value: ['x', 'y'] } }, rec), true);
  assert.equal(isVisible({ showIf: { field: 'c', op: 'truthy' } }, rec), true);
  assert.equal(isVisible({ showIf: { field: 'adjudicated_class', op: 'differs_from', value: 'proposed_class' } }, rec), false);
  assert.equal(isVisible({ showIf: { field: 'adjudicated_class', op: 'differs_from', value: 'proposed_class' } },
    { ...rec, adjudicated_class: 'Emergence delirium' }), true);
  assert.throws(() => isVisible({ showIf: { field: 'a', op: 'nonsense' } }, rec), /Unknown showIf operator/);
});

test('date of birth: future dates and decade slips are blocked', () => {
  assert.deepEqual(codes(validateDateOfBirth('2027-01-01', NOW)), ['future_date']);
  assert.deepEqual(codes(validateDateOfBirth('1998-01-01', NOW)), ['age_over_max']);
  assert.match(validateDateOfBirth('1998-01-01', NOW)[0].message, /Check the year/);
  assert.deepEqual(codes(validateDateOfBirth('2020-06-04', NOW)), []);
  assert.deepEqual(codes(validateDateOfBirth({ year: 2026, month: 2, day: 30 }, NOW)), ['unparseable']);
});

test('study number: a transposed sequence fails the check character', () => {
  assert.deepEqual(codes(validateStudyNumberField('PPP-KN-0147-0')), []);
  assert.deepEqual(codes(validateStudyNumberField('PPP-KN-0174-0')), ['check_character']);
  assert.deepEqual(codes(validateStudyNumberField('KN-0147-0')), ['format']);
  assert.deepEqual(codes(validateStudyNumberField('')), ['format']);
});

test('the three centres each get their own serial space, and a transposition still fails', () => {
  // CH, ME and GU enrol at the same time from separate paper logs. The same
  // four digits at two centres are two different children, and each number
  // carries its own check character — so a Meru number typed on a Chuka phone
  // does not quietly validate.
  const numbers = ['CH', 'ME', 'GU'].map((code) => formatStudyNumber(code, 31));
  assert.deepEqual(numbers, ['PPP-CH-0031-1', 'PPP-ME-0031-5', 'PPP-GU-0031-X']);
  assert.equal(new Set(numbers).size, 3);

  for (const n of numbers) assert.deepEqual(codes(validateStudyNumberField(n)), []);

  // The centre's letters are inside the checksum, so swapping them breaks it.
  assert.deepEqual(codes(validateStudyNumberField('PPP-ME-0031-1')), ['check_character']);
  // And a transposition inside the four typed digits is what it is there for.
  assert.deepEqual(codes(validateStudyNumberField('PPP-CH-0013-1')), ['check_character']);
});

test('theatre timestamps must run forwards and cannot be in the future', () => {
  const fields = ['anaesthesia_start', 'incision', 'closure', 'anaesthesia_end'];
  const good = {
    anaesthesia_start: '2026-09-11T09:00:00Z', incision: '2026-09-11T09:15:00Z',
    closure: '2026-09-11T09:50:00Z', anaesthesia_end: '2026-09-11T10:00:00Z',
  };
  assert.deepEqual(codes(validateTimestampSequence(good, fields, NOW)), []);

  const reversed = { ...good, closure: '2026-09-11T09:05:00Z' };
  assert.deepEqual(codes(validateTimestampSequence(reversed, fields, NOW)), ['out_of_sequence']);

  const future = { ...good, anaesthesia_end: '2026-09-11T23:00:00Z' };
  assert.ok(codes(validateTimestampSequence(future, fields, NOW)).includes('future_timestamp'));
});

test('a gap in the timestamp sequence does not create a false ordering error', () => {
  const fields = ['anaesthesia_start', 'incision', 'closure', 'anaesthesia_end'];
  const partial = { anaesthesia_start: '2026-09-11T09:00:00Z', anaesthesia_end: '2026-09-11T10:00:00Z' };
  assert.deepEqual(codes(validateTimestampSequence(partial, fields, NOW)), []);
});

test('local anaesthetic over the ceiling blocks; near it warns; no block is silent', () => {
  const ctx = { weightKg: 10, dateOfBirth: '2024-01-01', at: NOW };
  const over = { block_performed: true, la_agent: 'bupivacaine', la_concentration_pct: 0.25, la_volume_ml: 100 };
  assert.equal(validateLocalAnaesthetic(over, ctx)[0].level, BLOCK);

  const near = { block_performed: true, la_agent: 'bupivacaine', la_concentration_pct: 0.25, la_volume_ml: 9 };
  assert.equal(validateLocalAnaesthetic(near, ctx)[0].level, WARN);

  assert.deepEqual(validateLocalAnaesthetic({ block_performed: false }, ctx), []);
});

test('a duplicate scheduled timepoint blocks, an unscheduled one does not', () => {
  const existing = [{ study_number: 'PPP-KN-0147-0', timepoint: 'T18', submission_uuid: 'a' }];
  const dup = { study_number: 'PPP-KN-0147-0', timepoint: 'T18', submission_uuid: 'b' };
  assert.deepEqual(codes(validateNoDuplicateTimepoint(dup, existing)), ['duplicate_timepoint']);

  assert.deepEqual(codes(validateNoDuplicateTimepoint({ ...dup, timepoint: 'UNSCHED' }, existing)), []);
  assert.deepEqual(codes(validateNoDuplicateTimepoint({ ...dup, study_number: 'PPP-KN-0148-9' }, existing)), []);
  // A correction to the same row is not a duplicate of itself.
  assert.deepEqual(codes(validateNoDuplicateTimepoint({ ...dup, submission_uuid: 'a' }, existing)), []);
});

test('no module opens for a study number without a completed enrolment', () => {
  const enrolled = new Set(['PPP-KN-0147-0']);
  assert.deepEqual(codes(validateGatekeeper('PPP-KN-0147-0', enrolled)), []);
  assert.deepEqual(codes(validateGatekeeper('PPP-KN-0999-4', enrolled)), ['not_enrolled']);
});

test('implausible weight warns without blocking care', () => {
  const w = warnImplausibleWeight(3, '2020-01-01', NOW);
  assert.equal(w[0].level, WARN);
  assert.match(w[0].message, /Confirm the scale reading/);
  assert.deepEqual(warnImplausibleWeight(22, '2020-01-01', NOW), []);
  assert.deepEqual(warnImplausibleWeight(3.4, '2026-08-01', NOW), []);
});

test('soft warnings on the pain pair', () => {
  assert.equal(warnPainJump(8, 2)[0].code, 'pain_jump');
  assert.deepEqual(warnPainJump(6, 3), []);
  assert.deepEqual(warnPainJump(6, null), []);
  assert.equal(warnDynamicBelowRest(6, 3)[0].code, 'dynamic_below_rest');
  assert.deepEqual(warnDynamicBelowRest(3, 6), []);
});

test('respiratory depression warns and points to the adverse event form', () => {
  const w = warnRespiratoryDepression({ rr: 10, spo2: 97 }, { dateOfBirth: '2020-01-01', at: NOW });
  assert.equal(w[0].code, 'respiratory_depression');
  assert.match(w[0].message, /Open an adverse event record/);
  assert.deepEqual(warnRespiratoryDepression({ rr: 22, spo2: 98 }, { dateOfBirth: '2020-01-01', at: NOW }), []);
});

test('a high PAED outside the PACU is questioned, not rejected', () => {
  assert.equal(warnPaedOutsidePacu({ paed_total: 14 }, '05_pain_obs')[0].code, 'paed_outside_pacu');
  assert.deepEqual(warnPaedOutsidePacu({ paed_total: 14 }, '04_pacu_t0'), []);
  assert.deepEqual(warnPaedOutsidePacu({ paed_total: 4 }, '05_pain_obs'), []);
});

test('discharge below the Aldrete threshold warns', () => {
  assert.equal(warnAldrete({ aldrete: 7, pacu_discharge_at: NOW })[0].code, 'aldrete_below_threshold');
  assert.deepEqual(warnAldrete({ aldrete: 10, pacu_discharge_at: NOW }), []);
  assert.deepEqual(warnAldrete({ aldrete: 7, pacu_discharge_at: null }), []);
});

test('summarise separates what stops submission from what merely informs it', () => {
  const issues = [
    { level: WARN, code: 'pain_jump' },
    { level: BLOCK, code: 'required' },
    { level: WARN, code: 'la_near_max' },
  ];
  const s = summarise(issues);
  assert.equal(s.canSubmit, false);
  assert.equal(s.blocks.length, 1);
  assert.equal(s.warnings.length, 2);
  assert.equal(summarise(issues.filter((i) => i.level === WARN)).canSubmit, true);
});

/* ------------------------------------------------------------------ *
 * Retrospective entry
 *
 * Data will not always be collected in real time: ratios, emergencies and ward
 * logistics mean some assessments are written down and typed up later. That is
 * allowed, but it must be declared, because every derived interval depends on
 * assessed_at meaning the clinical event rather than the typing.
 * ------------------------------------------------------------------ */

test('entering at the bedside, in the moment, is silent', () => {
  const record = { assessed_at: '2026-09-11T11:50:00Z', entry_mode: 'At the bedside' };
  assert.deepEqual(warnEntryLag(record, { now: '2026-09-11T12:00:00Z' }), []);
});

test('a "bedside" record typed hours later is questioned, not blocked', () => {
  const record = { assessed_at: '2026-09-11T06:00:00Z', entry_mode: 'At the bedside' };
  const issues = warnEntryLag(record, { now: NOW });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, WARN);
  assert.equal(issues[0].code, 'entry_lag_disagrees');
  assert.match(issues[0].message, /6 h later/);
  assert.match(issues[0].message, /correct the assessment time/);
});

test('the same lag declared as notes is accepted without complaint', () => {
  const record = { assessed_at: '2026-09-11T06:00:00Z', entry_mode: 'From written notes' };
  assert.deepEqual(warnEntryLag(record, { now: NOW }), []);
});

test('recall stretched beyond a day is flagged for QC', () => {
  const record = { assessed_at: '2026-09-09T06:00:00Z', entry_mode: 'From recall' };
  const issues = warnEntryLag(record, { now: NOW });
  assert.equal(issues[0].code, 'recall_too_old');
  assert.match(issues[0].message, /may be excluded/);
});

test('recent recall is allowed — it is weaker data, not invalid data', () => {
  const record = { assessed_at: '2026-09-11T06:00:00Z', entry_mode: 'From recall' };
  assert.deepEqual(warnEntryLag(record, { now: NOW }), []);
});

test('nothing is warned about before an assessment time is given', () => {
  assert.deepEqual(warnEntryLag({ entry_mode: 'At the bedside' }, { now: NOW }), []);
});

test('retrospective entry never blocks — a late record still beats no record', () => {
  const late = { assessed_at: '2026-09-09T06:00:00Z', entry_mode: 'From recall' };
  const result = summarise(warnEntryLag(late, { now: NOW }));
  assert.equal(result.canSubmit, true);
  assert.equal(result.blocks.length, 0);
});
