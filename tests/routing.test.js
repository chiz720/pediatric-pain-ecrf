import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectInstrument, TOOLS, ageInRange, assentRequired, ageEchoLabel } from '../lib/routing.js';

const at = '2026-09-11';
const born = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

test('the 4-year boundary routes on the birthday', () => {
  assert.equal(selectInstrument({ dateOfBirth: born(2022, 9, 12), assessedAt: at }).tool, TOOLS.FLACC);
  assert.equal(selectInstrument({ dateOfBirth: born(2022, 9, 11), assessedAt: at }).tool, TOOLS.FPS_R);
});

test('the 8-year boundary routes on the birthday', () => {
  assert.equal(selectInstrument({ dateOfBirth: born(2018, 9, 12), assessedAt: at }).tool, TOOLS.FPS_R);
  assert.equal(selectInstrument({ dateOfBirth: born(2018, 9, 11), assessedAt: at }).tool, TOOLS.NRS);
});

test('a child three weeks short of four is still scored observationally', () => {
  const r = selectInstrument({ dateOfBirth: born(2022, 10, 2), assessedAt: at });
  assert.equal(r.tool, TOOLS.FLACC);
  assert.equal(r.years, 3);
});

test('a birthday crossed mid-admission changes the instrument', () => {
  const dob = born(2022, 9, 12);
  assert.equal(selectInstrument({ dateOfBirth: dob, assessedAt: '2026-09-11T22:00:00Z' }).tool, TOOLS.FLACC);
  assert.equal(selectInstrument({ dateOfBirth: dob, assessedAt: '2026-09-12T06:00:00Z' }).tool, TOOLS.FPS_R);
});

test('cognitive impairment overrides age at every age', () => {
  for (const y of [2025, 2020, 2012]) {
    assert.equal(
      selectInstrument({ dateOfBirth: born(y, 1, 1), assessedAt: at, cognitiveImpairment: true }).tool,
      TOOLS.R_FLACC,
    );
  }
});

test('PACU arrival collects both instruments regardless of age', () => {
  assert.equal(selectInstrument({ dateOfBirth: born(2012, 1, 1), assessedAt: at, phase: 'pacu_t0' }).tool, TOOLS.FLACC_PAED);
  assert.equal(selectInstrument({ dateOfBirth: born(2025, 1, 1), assessedAt: at, phase: 'pacu_t0' }).tool, TOOLS.FLACC_PAED);
});

test('a sleeping child suppresses the assessment rather than scoring zero', () => {
  const r = selectInstrument({ dateOfBirth: born(2015, 1, 1), assessedAt: at, asleep: true });
  assert.equal(r.tool, TOOLS.NOT_ASSESSED);
});

test('an assessment before birth is an error, not an age of zero', () => {
  assert.throws(() => selectInstrument({ dateOfBirth: born(2026, 12, 1), assessedAt: at }), /precedes date of birth/);
});

test('eligibility and assent follow the protocol ages', () => {
  assert.equal(ageInRange(born(2008, 1, 1), at).inRange, false);
  assert.equal(ageInRange(born(2009, 9, 11), at).inRange, true);
  assert.equal(assentRequired(born(2019, 9, 12), at), false);
  assert.equal(assentRequired(born(2019, 9, 11), at), true);
});

test('the enrolment echo names the age and the instrument it selects', () => {
  assert.equal(ageEchoLabel(born(2022, 7, 11), at), '4 y 2 m — FPS-R');
});
