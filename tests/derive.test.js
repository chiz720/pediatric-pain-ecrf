import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  onTimeFlag, cumulativeMmePerKg, timeToFirstRescue, painAuc,
  reboundPain, breakthroughPain24h, blockDurationHours, completeness,
} from '../lib/derive.js';

const END = '2026-09-11T10:00:00Z';
const plus = (h) => new Date(Date.parse(END) + h * 3600000).toISOString();

test('an assessment outside its window is flagged, with the drift recorded', () => {
  const late = onTimeFlag({ timepointId: 'T1', actualAt: plus(1.5), anaesthesiaEnd: END });
  assert.equal(late.onTime, false);
  assert.equal(late.driftMinutes, 30);
  assert.equal(late.windowMinutes, 15);
});

test('a T1 assessment 12 minutes late is inside its window', () => {
  const r = onTimeFlag({ timepointId: 'T1', actualAt: plus(1 + 12 / 60), anaesthesiaEnd: END });
  assert.equal(r.windowMinutes, 15);
  assert.equal(r.onTime, true);
});

test('the same 45-minute drift passes at T18 and fails at T2', () => {
  assert.equal(onTimeFlag({ timepointId: 'T2', actualAt: plus(2.75), anaesthesiaEnd: END }).onTime, false);
  assert.equal(onTimeFlag({ timepointId: 'T18', actualAt: plus(18.75), anaesthesiaEnd: END }).onTime, true);
});

test('T0 is anchored to PACU arrival, not to an offset', () => {
  const r = onTimeFlag({ timepointId: 'T0', actualAt: plus(0.4), anaesthesiaEnd: END, pacuArrival: plus(0.4) });
  assert.equal(r.applicable, false);
  assert.equal(r.onTime, true);
});

test('unscheduled assessments are recorded without a window judgement', () => {
  const r = onTimeFlag({ timepointId: 'UNSCHED', actualAt: plus(5), anaesthesiaEnd: END });
  assert.equal(r.applicable, false);
  assert.equal(r.onTime, null);
});

const doses = [
  { given_at: plus(0.5), drug: 'Fentanyl', route: 'IV', dose_amount: 20, dose_unit: 'mcg', indication: 'PRN rescue' },
  { given_at: plus(4),   drug: 'Paracetamol', route: 'IV', dose_amount: 150, dose_unit: 'mg', indication: 'Scheduled / around the clock' },
  { given_at: plus(8),   drug: 'Morphine', route: 'Oral', dose_amount: 2, dose_unit: 'mg', indication: 'PRN rescue' },
  { given_at: plus(30),  drug: 'Morphine', route: 'IV', dose_amount: 1, dose_unit: 'mg', indication: 'PRN rescue' },
];

test('cumulative MME per kg respects the window and ignores non-opioids', () => {
  // 24 h: fentanyl 20 mcg x0.3 = 6, oral morphine 2 mg x1 = 2, total 8 mg OME / 12 kg.
  assert.equal(cumulativeMmePerKg({ doses, weightKg: 12, anaesthesiaEnd: END, windowHours: 24 }), 0.667);
  // 48 h additionally picks up IV morphine 1 mg x3 = 3, total 11 / 12.
  assert.equal(cumulativeMmePerKg({ doses, weightKg: 12, anaesthesiaEnd: END, windowHours: 48 }), 0.917);
});

test('time to first rescue is censored, not zeroed, when no rescue is given', () => {
  assert.equal(timeToFirstRescue({ doses, anaesthesiaEnd: END }).hours, 0.5);
  assert.equal(timeToFirstRescue({ doses, anaesthesiaEnd: END, ivOnly: true }).hours, 0.5);

  const scheduledOnly = doses.filter((d) => d.indication !== 'PRN rescue');
  const r = timeToFirstRescue({ doses: scheduledOnly, anaesthesiaEnd: END });
  assert.equal(r.censored, true);
  assert.equal(r.hours, 48);
});

test('pain AUC flags thin coverage rather than reporting a confident number', () => {
  const sparse = [
    { assessed_at: plus(1), pain_rest: 2 },
    { assessed_at: plus(24), pain_rest: 6 },
  ];
  const r = painAuc({ observations: sparse, anaesthesiaEnd: END, windowHours: 24 });
  assert.equal(r.n, 2);
  assert.equal(r.sufficient, false);
  assert.equal(r.meanScore, 4);
});

test('pain AUC over a full schedule reports sufficient coverage', () => {
  const full = [0.5, 1, 2, 4, 6, 8, 12, 18, 24].map((h) => ({ assessed_at: plus(h), pain_rest: 3 }));
  const r = painAuc({ observations: full, anaesthesiaEnd: END, windowHours: 24 });
  assert.equal(r.meanScore, 3);
  assert.equal(r.sufficient, true);
});

test('rebound, protocol definition: requires rescue as well as escalation', () => {
  const escalated = reboundPain({
    definition: 'protocol', painBefore: 2, painAfterSeries: [8], rescueRequested: true,
  });
  assert.equal(escalated.rebound, true);
  assert.equal(escalated.escalation, 6);

  const noRescue = reboundPain({
    definition: 'protocol', painBefore: 2, painAfterSeries: [8], rescueRequested: false,
  });
  assert.equal(noRescue.rebound, false);
  assert.equal(noRescue.requiredRescue, true);
});

test('rebound, Barry definition: escalation alone, over a 24 hour window', () => {
  const r = reboundPain({ definition: 'barry', painBefore: 2, painAfterSeries: [8], rescueRequested: false });
  assert.equal(r.rebound, true);
  assert.equal(r.windowHours, 24);
  assert.equal(r.anchor, 'block_placement');
});

test('rebound requires well-controlled pain beforehand', () => {
  const neverControlled = reboundPain({
    definition: 'protocol', painBefore: 6, painAfterSeries: [9], rescueRequested: true,
  });
  assert.equal(neverControlled.rebound, false);
  assert.equal(neverControlled.wellControlledBefore, false);
});

test('rebound can read its series straight from the observation rows', () => {
  const obs = [
    { assessed_at: plus(0.5), pain_rest: 3 },
    { assessed_at: plus(1.5), pain_rest: 8 },
    { assessed_at: plus(6),   pain_rest: 9 },  // outside the 2 h protocol window
  ];
  const r = reboundPain({ definition: 'protocol', painBefore: 2, rescueRequested: true, anchorAt: END, observations: obs });
  assert.equal(r.peakAfter, 8);
  assert.equal(r.rebound, true);
});

test('breakthrough pain fires on score or on rescue, and reports which', () => {
  const byScore = breakthroughPain24h({
    observations: [{ assessed_at: plus(6), pain_rest: 5, pain_dynamic: 5 }], doses: [], anaesthesiaEnd: END,
  });
  assert.equal(byScore.outcome, 1);
  assert.equal(byScore.byPain, true);
  assert.equal(byScore.byRescue, false);

  const byRescue = breakthroughPain24h({
    observations: [{ assessed_at: plus(6), pain_rest: 2, pain_dynamic: 3 }], doses, anaesthesiaEnd: END,
  });
  assert.equal(byRescue.outcome, 1);
  assert.equal(byRescue.byPain, false);
  assert.equal(byRescue.byRescue, true);

  const neither = breakthroughPain24h({
    observations: [{ assessed_at: plus(6), pain_rest: 1, pain_dynamic: 3 }], doses: [], anaesthesiaEnd: END,
  });
  assert.equal(neither.outcome, 0);
});

test('breakthrough pain ignores events after the 24 hour window', () => {
  const late = breakthroughPain24h({
    observations: [{ assessed_at: plus(36), pain_rest: 9, pain_dynamic: 9 }], doses: [], anaesthesiaEnd: END,
  });
  assert.equal(late.outcome, 0);
});

test('block duration needs both timestamps, and returns null rather than zero', () => {
  assert.equal(blockDurationHours({ blockAt: END, sensoryReturnAt: plus(14) }), 14);
  assert.equal(blockDurationHours({ blockAt: END, sensoryReturnAt: null }), null);
  assert.equal(blockDurationHours({ blockAt: null, sensoryReturnAt: plus(14) }), null);
});

test('completeness reports the overnight gap that the protocol is most likely to lose', () => {
  const observed = [0.5, 1, 2, 4, 6, 8].map((h, i) => ({
    timepoint: ['T0_5', 'T1', 'T2', 'T4', 'T6', 'T8'][i], assessed_at: plus(h),
  }));
  const r = completeness({ observations: observed, anaesthesiaEnd: END });
  assert.equal(r.present, 6);
  assert.equal(r.expected, 13);
  assert.equal(r.meetsFloor, false);
  assert.equal(r.rows.find((x) => x.id === 'T18').present, false);
  assert.equal(r.rows.find((x) => x.id === 'T24').present, false);
});
