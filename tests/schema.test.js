import { PARAMS, CRF } from './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const forms = CRF.forms;
const allItems = forms.flatMap((f) =>
  f.sections.flatMap((s) => s.items.map((i) => ({ ...i, formId: f.id, sectionId: s.id }))));

/* ---------------- privacy containment: the build gate ---------------- */

test('date of birth is declared in exactly one form', () => {
  const { identifierFields, identifierAllowedForms } = PARAMS.privacy;
  const offenders = allItems.filter(
    (i) => identifierFields.includes(i.id) && !identifierAllowedForms.includes(i.formId),
  );
  assert.deepEqual(offenders.map((o) => `${o.formId}.${o.id}`), [],
    'An identifier field was declared outside its permitted form. See §02 of the plan.');

  for (const field of identifierFields) {
    const declaring = allItems.filter((i) => i.id === field);
    assert.equal(declaring.length, 1, `${field} should be declared exactly once, found ${declaring.length}`);
  }
});

test('every field flagged as an identifier is excluded from the analysis extract', () => {
  for (const field of PARAMS.privacy.identifierFields) {
    assert.ok(PARAMS.privacy.excludeFromAnalysisExtract.includes(field),
      `${field} is an identifier but is not excluded from the analysis extract`);
  }
});

test('items marked identifier:true match the privacy allowlist', () => {
  const marked = allItems.filter((i) => i.identifier === true).map((i) => i.id);
  assert.deepEqual(marked.sort(), [...PARAMS.privacy.identifierFields].sort());
});

test('free-text fields are enumerated in params so the nightly scan knows where to look', () => {
  const declared = allItems.filter((i) => i.freeText === true).map((i) => i.id).sort();
  assert.deepEqual(declared, [...PARAMS.privacy.freeTextFields].sort(),
    'Every freeText item must be listed in params.privacy.freeTextFields, and vice versa.');
});

/* ---------------- structural integrity ---------------- */

test('form and item identifiers are unique where they must be', () => {
  const formIds = forms.map((f) => f.id);
  assert.equal(new Set(formIds).size, formIds.length, 'duplicate form id');

  for (const form of forms) {
    const ids = form.sections.flatMap((s) => s.items.map((i) => i.id));
    const dupes = ids.filter((id, n) => ids.indexOf(id) !== n);
    assert.deepEqual(dupes, [], `duplicate item id within ${form.id}`);
  }
});

test('every showIf points at a field that exists in the same form', () => {
  for (const form of forms) {
    const ids = new Set(form.sections.flatMap((s) => s.items.map((i) => i.id)));
    // Fields derived from the enrolment record are available to every form.
    ['age_days', 'age_months', 'age_years', 'weight_kg', 'procedure_category'].forEach((f) => ids.add(f));
    for (const section of form.sections) {
      for (const item of section.items) {
        if (!item.showIf) continue;
        assert.ok(ids.has(item.showIf.field),
          `${form.id}.${item.id} branches on unknown field ${item.showIf.field}`);
        if (item.showIf.op === 'differs_from') {
          assert.ok(ids.has(item.showIf.value),
            `${form.id}.${item.id} compares against unknown field ${item.showIf.value}`);
        }
      }
    }
  }
});

test('every item has a label and a known type', () => {
  const KNOWN = new Set([
    'text', 'textarea', 'secret', 'integer', 'decimal', 'slider', 'boolean', 'select', 'multiselect',
    'date_parts', 'datetime', 'study_number', 'computed', 'drug_table', 'dose_block',
    'pain_auto', 'flacc', 'paed', 'mypas_sf', 'umss',
  ]);
  for (const item of allItems) {
    assert.ok(item.label, `${item.formId}.${item.id} has no label`);
    assert.ok(KNOWN.has(item.type), `${item.formId}.${item.id} has unknown type ${item.type}`);
  }
});

test('computed fields are read-only and name a derivation', () => {
  for (const item of allItems.filter((i) => i.type === 'computed')) {
    assert.equal(item.readOnly, true, `${item.formId}.${item.id} is computed but not read-only`);
    assert.ok(item.derive, `${item.formId}.${item.id} is computed but names no derivation`);
    assert.notEqual(item.required, true, `${item.formId}.${item.id} is computed and must not be required of a rater`);
  }
});

test('select items offer options from somewhere', () => {
  for (const item of allItems.filter((i) => i.type === 'select' || i.type === 'multiselect')) {
    const hasOptions = Array.isArray(item.options) || item.optionsFromParams || item.sameOptionsAs;
    assert.ok(hasOptions, `${item.formId}.${item.id} is a select with no options`);
    if (Array.isArray(item.options)) {
      assert.ok(item.options.length >= 2, `${item.formId}.${item.id} has fewer than two options`);
    }
  }
});

test('optionsFromParams paths resolve', () => {
  for (const item of allItems.filter((i) => i.optionsFromParams)) {
    const value = item.optionsFromParams.split('.').reduce((o, k) => (o == null ? o : o[k]), PARAMS);
    assert.ok(value, `${item.formId}.${item.id} points at missing params path ${item.optionsFromParams}`);
  }
});

test('numeric items declare bounds so validation has something to enforce', () => {
  for (const item of allItems.filter((i) => ['integer', 'decimal', 'slider'].includes(i.type))) {
    assert.ok(item.min != null && item.max != null,
      `${item.formId}.${item.id} is numeric without both min and max`);
    assert.ok(item.min < item.max, `${item.formId}.${item.id} has min >= max`);
  }
});

test('every non-local form maps to a sheet tab, and every tab is unique', () => {
  const sheets = forms.filter((f) => f.cardinality !== 'local').map((f) => f.sheet);
  assert.ok(sheets.every(Boolean), 'a submitted form has no sheet');
  assert.equal(new Set(sheets).size, sheets.length, 'two forms write to the same tab');
  assert.equal(forms.find((f) => f.cardinality === 'local').sheet, null);
});

test('the enrolment form is the only gatekeeper', () => {
  const gates = forms.filter((f) => f.gatekeeper);
  assert.deepEqual(gates.map((g) => g.id), ['01_enrolment']);
});

/* ---------------- parameter integrity ---------------- */

test('schema and params declare the same version pairing', () => {
  assert.equal(CRF.paramsVersion, PARAMS.paramsVersion);
});

test('instrument age bands are contiguous and non-overlapping', () => {
  const r = PARAMS.routing;
  assert.equal(r.fpsrMinYears, r.flaccMaxYears + 1);
  assert.equal(r.nrsMinYears, r.fpsrMaxYears + 1);
  assert.ok(r.maxEnrolmentYears > r.nrsMinYears);
  assert.ok(r.assentMinYears > 0 && r.assentMinYears < r.maxEnrolmentYears);
});

test('pain bands tile 0-10 exactly once', () => {
  const covered = [];
  for (const [name, band] of Object.entries(PARAMS.painBands)) {
    if (name.startsWith('_')) continue;          // _source and friends are metadata
    const [lo, hi] = band;
    assert.ok(Number.isInteger(lo) && Number.isInteger(hi), `band ${name} is not a numeric pair`);
    for (let v = lo; v <= hi; v += 1) covered.push(v);
  }
  covered.sort((a, b) => a - b);
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('the ward schedule is the five timepoints on the clinical form', () => {
  const tps = PARAMS.assessmentSchedule.timepoints;
  assert.deepEqual(tps.map((t) => t.id), ['T2', 'T6', 'T12', 'T24', 'T48']);
  assert.equal(new Set(tps.map((t) => t.id)).size, 5);
  for (let i = 1; i < tps.length; i += 1) {
    assert.ok(tps[i].offsetHours > tps[i - 1].offsetHours, `${tps[i].id} does not follow ${tps[i - 1].id}`);
  }
  assert.equal(tps.at(-1).offsetHours, 48);
});

test('PACU emergence is scored at arrival, 30 and 60 minutes', () => {
  const tps = PARAMS.paedSchedule.timepoints;
  assert.deepEqual(tps.map((t) => t.offsetMinutes), [0, 30, 60]);
});

test('the form option lists exist for every choice the paper form offers', () => {
  const o = PARAMS.formOptions;
  for (const key of ['sex', 'asa', 'surgicalDomain', 'approach', 'laterality',
    'anaesthesiaType', 'maintenanceRoute', 'gasAgent', 'infusionAgent', 'sedativeAgent',
    'block', 'guidance', 'consent']) {
    assert.ok(Array.isArray(o[key]) && o[key].length >= 2, `formOptions.${key} is missing or too short`);
  }
  assert.ok(o.block.includes('None'), 'the block list must allow "None"');
  assert.ok(o.laterality.includes('Bilateral'), 'paediatric hernias come in pairs');
});

test('every anaesthetic agent declares the unit it is charted in', () => {
  // A volatile is a fraction of MAC, a propofol infusion is mg/kg/hr and a
  // ketamine one is mcg/kg/min. An agent offered on the form with no declared
  // unit would record a bare number, and a rate without its unit is how a
  // tenfold error survives to the end of a study.
  const units = PARAMS.anaesthesia.doseUnits;
  const offered = [...new Set([
    ...PARAMS.formOptions.gasAgent,
    ...PARAMS.formOptions.infusionAgent,
    ...PARAMS.formOptions.sedativeAgent,
  ])];
  for (const agent of offered) {
    assert.ok(units[agent], `${agent} is offered on the form but declares no charting unit`);
  }
  // And nothing is declared that the form cannot offer.
  for (const agent of Object.keys(units)) {
    assert.ok(offered.includes(agent), `${agent} has a unit but appears on no agent list`);
  }
  // The units are genuinely different from one another — that is the point of
  // storing one per agent rather than one per form.
  assert.equal(units.Propofol, 'mg/kg/hr');
  assert.equal(units.Ketamine, 'mcg/kg/min');
  assert.equal(units.Dexmedetomidine, 'mcg/kg/hr');
  assert.equal(units.Midazolam, 'mg/kg');     // a bolus, not a rate
});

test('sedatives that cannot maintain a general anaesthetic stay off the TIVA list', () => {
  // Midazolam and dexmedetomidine sedate; neither holds a child anaesthetic on
  // its own. Offering them under General > TIVA would invite a record of a
  // maintenance nobody gave.
  const { infusionAgent, sedativeAgent } = PARAMS.formOptions;
  for (const agent of ['Midazolam', 'Dexmedetomidine']) {
    assert.ok(sedativeAgent.includes(agent), `${agent} should be offered for sedation`);
    assert.ok(!infusionAgent.includes(agent), `${agent} must not be offered as TIVA maintenance`);
  }
});

test('windows are non-decreasing as the interval lengthens', () => {
  const windows = PARAMS.assessmentSchedule.timepoints
    .filter((t) => t.windowMinutes != null)
    .map((t) => t.windowMinutes);
  for (let i = 1; i < windows.length; i += 1) {
    assert.ok(windows[i] >= windows[i - 1], 'a later timepoint has a tighter window than an earlier one');
  }
});

test('rebound definitions share a metric but differ in anchor and window', () => {
  const { protocol, barry } = PARAMS.rebound;
  assert.equal(protocol.fromAtMost, barry.fromAtMost);
  assert.equal(protocol.toAtLeast, barry.toAtLeast);
  assert.notEqual(protocol.anchor, barry.anchor);
  assert.ok(barry.windowHours > protocol.windowHours);
  assert.equal(protocol.requireRescue, true);
});

test('thresholds are internally consistent with the pain bands', () => {
  const t = PARAMS.thresholds;
  assert.equal(t.moderateToSevere, PARAMS.painBands.moderate[0]);
  assert.equal(t.severePain, PARAMS.painBands.severe[0]);
  assert.equal(t.wellControlled, PARAMS.painBands.mild[1]);
  assert.equal(t.flaccIntervene, t.moderateToSevere);
  assert.ok(t.paedEdCutoffSensitivity > t.paedEdCutoff);
  assert.ok(t.irrKappaGate > 0.8 && t.irrKappaGate <= 1);
});

test('every MME and fentanyl factor declares a unit', () => {
  for (const [key, spec] of Object.entries(PARAMS.opioids.mme.factors)) {
    assert.ok(['mg', 'mcg'].includes(spec.unit), `${key} has no usable unit`);
    assert.ok(spec.factor > 0, `${key} has a non-positive factor`);
  }
  for (const [key, spec] of Object.entries(PARAMS.opioids.fentanylEquivalents.factors)) {
    assert.ok(['mg', 'mcg'].includes(spec.unit), `${key} has no usable unit`);
    assert.ok(spec.factor > 0, `${key} has a non-positive factor`);
  }
});

test('every local anaesthetic declares a maximum', () => {
  for (const [key, spec] of Object.entries(PARAMS.localAnaesthetic.agents)) {
    assert.ok(spec.maxMgPerKg > 0, `${key} has no maximum`);
    if (spec.maxMgPerKgWithEpi) {
      assert.ok(spec.maxMgPerKgWithEpi > spec.maxMgPerKg, `${key} epinephrine ceiling is not higher`);
    }
  }
  assert.ok(PARAMS.localAnaesthetic.infantReductionFactor < 1);
  assert.ok(PARAMS.localAnaesthetic.warnFractionOfMax < 1);
});

test('respiratory rate bands are ordered and terminate in an open band', () => {
  const bands = PARAMS.respiratoryDepression.respiratoryRateThresholds;
  assert.equal(bands.at(-1).maxYears, null);
  for (let i = 1; i < bands.length - 1; i += 1) {
    assert.ok(bands[i].maxYears > bands[i - 1].maxYears);
    assert.ok(bands[i].minRatePerMin < bands[i - 1].minRatePerMin);
  }
});

test('every parameter group cites a source', () => {
  const groups = ['routing', 'painBands', 'localAnaesthetic', 'respiratoryDepression', 'restrictedDrugs'];
  for (const g of groups) {
    const node = PARAMS[g];
    const hasProvenance = node._source || node._basis || node._definition;
    assert.ok(hasProvenance, `params.${g} cites no source`);
  }
  assert.ok(PARAMS.opioids.mme._source);
  assert.ok(PARAMS.thresholds.paedSource);
});
