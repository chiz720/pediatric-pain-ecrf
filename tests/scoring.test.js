import './_setup.js';
import { PARAMS } from './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flaccTotal, paedTotal, fpsrScore, nrsScore, mypasSfScore, painBand, bmi,
  localAnaestheticDose, doseMme, fentanylEquivalents, pacuClassification,
  respiratoryDepression, restrictedForAge, resolveMmeKey, pacuPathway, isModerateToSevere,
  reboundCriteria,
} from '../lib/scoring.js';

const at = '2026-09-11';

test('FLACC sums five domains and rejects anything else', () => {
  assert.equal(flaccTotal({ face: 0, legs: 0, activity: 0, cry: 0, consolability: 0 }), 0);
  assert.equal(flaccTotal({ face: 2, legs: 2, activity: 2, cry: 2, consolability: 2 }), 10);
  assert.equal(flaccTotal({ face: 1, legs: 0, activity: 2, cry: 1, consolability: 0 }), 4);
  assert.throws(() => flaccTotal({ face: 3, legs: 0, activity: 0, cry: 0, consolability: 0 }), /FLACC face/);
  assert.throws(() => flaccTotal({ face: 1, legs: 1, activity: 1, cry: 1 }), /FLACC consolability/);
});

test('PAED reverse-scores the first three items so the rater never has to', () => {
  // "Not at all" (0) on the three positive items is maximal delirium: 4+4+4.
  assert.equal(paedTotal({ eye_contact: 0, purposeful: 0, aware: 0, restless: 4, inconsolable: 4 }), 20);
  // A fully oriented, settled child scores zero.
  assert.equal(paedTotal({ eye_contact: 4, purposeful: 4, aware: 4, restless: 0, inconsolable: 0 }), 0);
  // Mid-scale is symmetric.
  assert.equal(paedTotal({ eye_contact: 2, purposeful: 2, aware: 2, restless: 2, inconsolable: 2 }), 10);
  assert.throws(() => paedTotal({ eye_contact: 5, purposeful: 0, aware: 0, restless: 0, inconsolable: 0 }), /PAED eye_contact/);
});

test('FPS-R returns the 0-10 metric value, not the face position', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(fpsrScore), [0, 2, 4, 6, 8, 10]);
  assert.throws(() => fpsrScore(6), /FPS-R face index/);
});

test('NRS accepts the full 11-point range and nothing outside it', () => {
  assert.equal(nrsScore(0), 0);
  assert.equal(nrsScore(10), 10);
  assert.throws(() => nrsScore(11), /NRS/);
  assert.throws(() => nrsScore(4.5), /NRS/);
});

test('m-YPAS-SF spans 22.92 to 100 across four domains', () => {
  assert.equal(mypasSfScore({ activity: 1, vocalisation: 1, expressivity: 1, arousal: 1 }), 22.92);
  assert.equal(mypasSfScore({ activity: 4, vocalisation: 6, expressivity: 4, arousal: 4 }), 100);
  assert.ok(mypasSfScore({ activity: 2, vocalisation: 3, expressivity: 2, arousal: 2 }) > 22.92);
  assert.throws(() => mypasSfScore({ activity: 5, vocalisation: 1, expressivity: 1, arousal: 1 }), /activity/);
  assert.throws(() => mypasSfScore({ activity: 0, vocalisation: 1, expressivity: 1, arousal: 1 }), /activity/);
});

test('pain bands follow the published cut points', () => {
  assert.equal(painBand(0), 'none');
  assert.equal(painBand(3), 'mild');
  assert.equal(painBand(4), 'moderate');
  assert.equal(painBand(6), 'moderate');
  assert.equal(painBand(7), 'severe');
});

test('BMI', () => {
  assert.equal(bmi(16, 100), 16);
  assert.throws(() => bmi(0, 100), /positive/);
});

test('local anaesthetic dose blocks above the ceiling and warns below it', () => {
  const weightKg = 10;
  // 0.25% bupivacaine, 10 mL = 25 mg = 2.5 mg/kg — exactly at the maximum.
  const atMax = localAnaestheticDose({ agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 10, weightKg });
  assert.equal(atMax.mgPerKg, 2.5);
  assert.equal(atMax.pctOfMax, 100);
  assert.equal(atMax.verdict, 'warn');

  // A decimal slip: 100 mL instead of 10.
  const slip = localAnaestheticDose({ agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 100, weightKg: 10 });
  assert.equal(slip.verdict, 'block');
  assert.match(slip.message, /exceeds the maximum/);

  // Comfortably inside.
  assert.equal(localAnaestheticDose({ agent: 'ropivacaine', concentrationPct: 0.2, volumeMl: 5, weightKg: 10 }).verdict, 'ok');
});

test('the infant reduction tightens the ceiling under six completed months', () => {
  const infant = localAnaestheticDose({
    agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 8, weightKg: 10,
    dateOfBirth: '2026-04-11', at, // 5 months
  });
  assert.equal(infant.infantReduced, true);
  assert.equal(infant.maxMgPerKg, 1.75);
  assert.equal(infant.verdict, 'block');

  const older = localAnaestheticDose({
    agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 8, weightKg: 10,
    dateOfBirth: '2026-03-11', at, // 6 months
  });
  assert.equal(older.infantReduced, false);
  assert.equal(older.maxMgPerKg, 2.5);
  // Same dose, same weight: only the ceiling moved. 2.0 of 2.5 mg/kg is exactly
  // the 80% warn boundary, which is inclusive.
  assert.equal(older.pctOfMax, 80);
  assert.equal(older.verdict, 'warn');
});

test('epinephrine raises the lidocaine ceiling only', () => {
  // 1% lidocaine, 5.5 mL, 10 kg = 5.5 mg/kg: over the plain ceiling of 5,
  // comfortably inside the 7 mg/kg ceiling with epinephrine.
  const plain = localAnaestheticDose({ agent: 'lidocaine', concentrationPct: 1, volumeMl: 5.5, weightKg: 10 });
  const withEpi = localAnaestheticDose({ agent: 'lidocaine', concentrationPct: 1, volumeMl: 5.5, weightKg: 10, withEpinephrine: true });
  assert.equal(plain.verdict, 'block');
  assert.equal(withEpi.verdict, 'ok');

  const bupi = localAnaestheticDose({ agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 12, weightKg: 10, withEpinephrine: true });
  assert.equal(bupi.maxMgPerKg, 2.5);
});

test('MME conversion is route-aware and refuses a unit mismatch', () => {
  assert.equal(doseMme({ drug: 'Morphine', route: 'Oral', amount: 10, unit: 'mg' }), 10);
  assert.equal(doseMme({ drug: 'Morphine', route: 'IV', amount: 10, unit: 'mg' }), 30);
  assert.equal(doseMme({ drug: 'Fentanyl', route: 'IV', amount: 50, unit: 'mcg' }), 15);
  assert.equal(doseMme({ drug: 'Paracetamol', route: 'IV', amount: 150, unit: 'mg' }), 0);
  assert.throws(() => doseMme({ drug: 'Fentanyl', route: 'IV', amount: 0.05, unit: 'mg' }), /recorded in mg/);
  assert.equal(resolveMmeKey('Oxycodone', 'IV'), null);
});

test('intraoperative opioids convert to fentanyl equivalents', () => {
  assert.equal(fentanylEquivalents([{ drug: 'fentanyl', amount: 20, unit: 'mcg' }]), 20);
  assert.equal(fentanylEquivalents([
    { drug: 'fentanyl', amount: 20, unit: 'mcg' },
    { drug: 'morphine', amount: 2, unit: 'mg' },
  ]), 40);
  assert.throws(() => fentanylEquivalents([{ drug: 'pethidine', amount: 1, unit: 'mg' }]), /No fentanyl-equivalent factor/);
});

test('PACU adjudication: behavioural gates can override the PAED score', () => {
  const gates = (o) => ({ eye_contact: false, purposeful: false, aware: false, consolable: false, ...o });

  const pain = pacuClassification({ paedTotal: 6, flaccTotal: 7, gates: gates({ eye_contact: true, purposeful: true }) });
  assert.equal(pain.classification, 'Nociception');
  assert.match(pain.prompt, /analgesia per protocol/);

  const ed = pacuClassification({ paedTotal: 14, flaccTotal: 8, gates: gates() });
  assert.equal(ed.classification, 'Emergence delirium');
  assert.match(ed.prompt, /Withhold opioid escalation/);

  const override = pacuClassification({ paedTotal: 14, flaccTotal: 6, gates: gates({ eye_contact: true, purposeful: true }) });
  assert.equal(override.classification, 'Nociception');
  assert.match(override.rationale, /override the score/);

  const unclear = pacuClassification({ paedTotal: 12, flaccTotal: 3, gates: gates({ eye_contact: true }) });
  assert.equal(unclear.classification, 'Indeterminate');
  assert.equal(unclear.prompt, null);
});

test('PACU adjudication does not prompt analgesia below the FLACC threshold', () => {
  const r = pacuClassification({
    paedTotal: 4, flaccTotal: 3,
    gates: { eye_contact: true, purposeful: true, aware: true, consolable: true },
  });
  assert.equal(r.classification, 'Nociception');
  assert.equal(r.prompt, null);
});

test('respiratory depression thresholds are age-indexed', () => {
  const infant = respiratoryDepression({ respiratoryRate: 18, spo2: 98, dateOfBirth: '2026-06-11', at });
  assert.equal(infant.triggered, true);
  assert.equal(infant.threshold, 20);

  const teen = respiratoryDepression({ respiratoryRate: 18, spo2: 98, dateOfBirth: '2012-01-01', at });
  assert.equal(teen.triggered, false);
  assert.equal(teen.threshold, 12);

  const desat = respiratoryDepression({ respiratoryRate: 24, spo2: 90, dateOfBirth: '2020-01-01', at });
  assert.equal(desat.triggered, true);
  assert.match(desat.reasons[0], /SpO2 90%/);

  const naloxone = respiratoryDepression({ respiratoryRate: 24, spo2: 99, naloxoneGiven: true, dateOfBirth: '2020-01-01', at });
  assert.equal(naloxone.triggered, true);
});

test('codeine and tramadol flag by age but never block', () => {
  const young = restrictedForAge({ drug: 'Codeine', route: 'Oral', dateOfBirth: '2018-01-01', at });
  assert.equal(young.restricted, true);
  assert.equal(young.blocks, false);
  assert.equal(young.flagToQc, true);

  const older = restrictedForAge({ drug: 'Codeine', route: 'Oral', dateOfBirth: '2010-01-01', at });
  assert.equal(older.restricted, false);

  const postTonsil = restrictedForAge({
    drug: 'Tramadol', route: 'Oral', dateOfBirth: '2010-01-01', at,
    procedureCategory: 'Tonsillectomy / adenoidectomy',
  });
  assert.equal(postTonsil.restricted, true);

  assert.equal(restrictedForAge({ drug: 'Morphine', route: 'IV', dateOfBirth: '2018-01-01', at }).restricted, false);
});

test('every theatre opioid declares the unit its MME factor expects', () => {
  // doseMme throws on a unit mismatch rather than converting, which is correct
  // and also means a form offering fentanyl in mg would fail at the bedside
  // rather than in review. The agent list and the factor table must agree.
  const { agents } = PARAMS.opioids.intraoperative;
  for (const agent of agents) {
    const key = resolveMmeKey(agent.name, 'IV');
    if (!key) continue;
    const spec = PARAMS.opioids.mme.factors[key];
    assert.equal(agent.unit, spec.unit,
      `${agent.name} is offered in ${agent.unit} but ${key} converts from ${spec.unit}`);
  }
});

test('a theatre opioid with no IV factor converts to nothing, not to zero', () => {
  // Pethidine has no entry in the route map, so resolveMmeKey returns null and
  // the form excludes it by name. doseMme would answer 0, and 0 mg of morphine
  // equivalent for a child who got pethidine is a wrong number, not a missing
  // one — this test pins which drugs are in that state.
  const withoutFactor = PARAMS.opioids.intraoperative.agents
    .filter((a) => !resolveMmeKey(a.name, 'IV'))
    .map((a) => a.name);
  assert.deepEqual(withoutFactor, ['Pethidine']);
  assert.equal(doseMme({ drug: 'Pethidine', route: 'IV', amount: 25, unit: 'mg' }), 0);
});

test('the cumulative morphine equivalent of a real theatre log', () => {
  // Fentanyl 20 mcg + 10 mcg at 0.3, morphine 1 mg IV at 3.
  const log = [
    { drug: 'Fentanyl', route: 'IV', amount: 20, unit: 'mcg' },
    { drug: 'Fentanyl', route: 'IV', amount: 10, unit: 'mcg' },
    { drug: 'Morphine', route: 'IV', amount: 1, unit: 'mg' },
  ];
  const total = log.reduce((sum, d) => sum + doseMme(d), 0);
  assert.equal(Math.round(total * 1000) / 1000, 12);
});

test('every block adjuvant declares a dose unit, except the one with no dose', () => {
  // Adrenaline is recorded for what it does to the ceiling, not for its dose,
  // so it alone carries a null unit. Everything else must say mg or mcg —
  // confusing those two is a thousandfold error in a caudal.
  const { adjuvants } = PARAMS.localAnaesthetic;
  const unitless = adjuvants.filter((a) => a.unit === null).map((a) => a.name);
  assert.deepEqual(unitless, ['Adrenaline']);
  for (const a of adjuvants.filter((x) => x.unit !== null)) {
    assert.ok(['mg', 'mcg'].includes(a.unit), `${a.name} declares ${a.unit}`);
  }
});

test('adrenaline raises the lidocaine ceiling and nothing else', () => {
  // This is why adrenaline is recorded at all: it is the difference between a
  // dose the form refuses and one it accepts.
  const plain = localAnaestheticDose({
    agent: 'lidocaine', concentrationPct: 1, volumeMl: 8, weightKg: 14,
  });
  const withEpi = localAnaestheticDose({
    agent: 'lidocaine', concentrationPct: 1, volumeMl: 8, weightKg: 14, withEpinephrine: true,
  });
  assert.equal(plain.maxMgPerKg, 5);
  assert.equal(withEpi.maxMgPerKg, 7);
  assert.equal(plain.mgPerKg, withEpi.mgPerKg);
  assert.ok(withEpi.pctOfMax < plain.pctOfMax);

  // Bupivacaine has no adrenaline ceiling, so the flag must change nothing.
  const bupi = localAnaestheticDose({
    agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 8, weightKg: 14,
  });
  const bupiEpi = localAnaestheticDose({
    agent: 'bupivacaine', concentrationPct: 0.25, volumeMl: 8, weightKg: 14, withEpinephrine: true,
  });
  assert.equal(bupi.maxMgPerKg, bupiEpi.maxMgPerKg);
});

test('a PACU timepoint points at pain, at delirium, or at neither', () => {
  // Below the cutoff, distress is pain until shown otherwise.
  assert.equal(pacuPathway({ paedTotal: 6, purposeful: 3 }).pathway, 'pain');
  assert.equal(pacuPathway({ paedTotal: 0, purposeful: 0 }).pathway, 'pain');

  // At or above it with non-purposeful movement, delirium — and the message
  // must say what to do, because the wrong answer here is more opioid.
  const ed = pacuPathway({ paedTotal: 14, purposeful: 0 });
  assert.equal(ed.pathway, 'delirium');
  assert.match(ed.message, /not more opioid/);

  // The same total with purposeful movement is pain: purpose overrides score.
  const override = pacuPathway({ paedTotal: 14, purposeful: 2, eyeContact: 3 });
  assert.equal(override.pathway, 'pain');
  assert.match(override.message, /purposeful/);

  // An elevated total with that item unscored commits to nothing.
  assert.equal(pacuPathway({ paedTotal: 14, purposeful: null }).pathway, 'indeterminate');
});

test('the PACU pathway turns on the cutoff and invents no threshold of its own', () => {
  const cutoff = PARAMS.thresholds.paedEdCutoff;
  assert.equal(pacuPathway({ paedTotal: cutoff - 1, purposeful: 0 }).pathway, 'pain');
  assert.equal(pacuPathway({ paedTotal: cutoff, purposeful: 0 }).pathway, 'delirium');
  assert.throws(() => pacuPathway({ paedTotal: 21, purposeful: 0 }), /PAED total/);
});

test('the treatment threshold and the pain bands agree on where moderate starts', () => {
  // The PACU prompt says "at or above N, rescue is indicated" and bands the
  // same number as moderate. If these two parameters ever drifted apart the
  // form would contradict itself on screen.
  const t = PARAMS.thresholds;
  assert.equal(painBand(t.moderateToSevere), 'moderate');
  assert.equal(painBand(t.moderateToSevere - 1), 'mild');
  assert.equal(painBand(t.severePain), 'severe');
  assert.equal(isModerateToSevere(t.moderateToSevere), true);
  assert.equal(isModerateToSevere(t.moderateToSevere - 1), false);

  // And the whole 0-10 metric is banded, since any of FLACC, FPS-R or NRS can
  // land in this box.
  for (let score = 0; score <= 10; score += 1) {
    assert.ok(['none', 'mild', 'moderate', 'severe'].includes(painBand(score)));
  }
});

test('the rebound criteria on screen are written from the parameters', () => {
  // The wording used to be literal text in two places in the form, so a
  // change to windowHours left the screen contradicting the definition it was
  // meant to be enforcing. Every number in the label now comes from params.
  const d = PARAMS.rebound.protocol;
  const label = reboundCriteria();
  assert.match(label, new RegExp(`\u2264${d.fromAtMost}`));
  assert.match(label, new RegExp(`\u2265${d.toAtLeast}`));
  assert.match(label, new RegExp(`within ${d.windowHours} h`));
  assert.match(label, /block wearing off/);        // anchor: sensory_regression
  assert.match(label, /with rescue/);              // requireRescue: true

  // The published definition differs in every one of those respects, and the
  // same function must say so rather than repeating the protocol's wording.
  const barry = reboundCriteria('barry');
  assert.match(barry, new RegExp(`within ${PARAMS.rebound.barry.windowHours} h`));
  assert.match(barry, /block going in/);           // anchor: block_placement
  assert.ok(!barry.includes('with rescue'));       // requireRescue: false
  assert.notEqual(label, barry);
});

test('an anchor with no wording fails loudly rather than labelling it undefined', () => {
  // A nurse reading nonsense criteria at 3 a.m. is worse than a build that
  // breaks here, so a new anchor in params must be given words deliberately.
  assert.throws(() => reboundCriteria('nonexistent'), /No rebound definition/);
});
