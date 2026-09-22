/**
 * The clinical research form.
 *
 * Five modules, each saved on its own, because different people fill them at
 * different hours: theatre fills Module 2, recovery fills Module 3, the ward
 * fills Module 4 five times over two days.
 *
 * Everything the paper form asks a human to work out, this works out instead —
 * BMI, the PAED total, which pain scale applies, the weight-adjusted OME, and
 * whether a local anaesthetic dose has gone over the ceiling.
 */

import { CONFIG } from './config.js';
import { loadParams, params } from './lib/params.js';
import { selectInstrument, monthsLabel, TOOLS } from './lib/routing.js';
import { ageMonths, ageLabel, isFuture } from './lib/age.js';
import { flaccTotal, paedTotal, mypasSfScore, bmi, localAnaestheticDose, doseMme, resolveMmeKey, pacuPathway } from './lib/scoring.js';
import { minutesBetween, durationLabel, surgeryWithinAnaesthesia } from './lib/clock.js';
import { validate as checkSubjectId, format as formatSubjectId, parse as parseSubjectId } from './lib/studyNumber.js';
import * as sync from './lib/sync.js';

const APP_VERSION = '2026.09.23a-crf';
const WHO_KEY = 'ppp.who';
const CENTRE_KEY = 'ppp.centre';
const ENROLLED_KEY = 'ppp.enrolled';
const SAVED_KEY = 'ppp.saved';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  kids.flat().forEach((c) => c && n.append(c));
  return n;
};
const num = (id) => { const v = $(id).value; return v === '' ? null : Number(v); };

/** One child's form, held until each module is saved. */
const F = {
  subjectId: '', consent: new Set(), evalDate: '',
  m1: {}, m2: {}, m5: {},
  paed: {},                 // { P0: {...items}, P30: {...}, P60: {...} }
  ward: {},                 // { T2: {rest, move, rebound, rescue}, ... }
  paedTab: 'P0', wardTab: 'T2',
};
let who = '';
let centre = null;                 // { code, name } — the phone's enrolling centre
let routed = null;
let syncCfg = null;

/* ------------------------------------------------------------------ */

async function boot() {
  const paramsJson = await fetch('./schema/params.json').then((r) => r.json());
  loadParams(paramsJson);

  syncCfg = {
    endpointUrl: CONFIG.endpointUrl, token: CONFIG.campKey,
    deviceId: deviceId(), raterId: null, training: false,
    schemaVersion: '1.0.0', paramsVersion: paramsJson.paramsVersion, appVersion: APP_VERSION,
  };

  // Evaluator is typed, not chosen: locums and swapped shifts mean the name on
  // the record is often not one config.js knows about. The camp list is offered
  // as suggestions so the regulars still type once and then tap.
  who = localStorage.getItem(WHO_KEY) || '';
  $('collectorList').replaceChildren(...CONFIG.collectors.map((name) => el('option', { value: name })));
  $('evaluator').value = who;
  $('evaluator').addEventListener('input', () => {
    who = $('evaluator').value.trim();
    localStorage.setItem(WHO_KEY, who);
    showWho();
  });
  showWho();
  $('changeWho').addEventListener('click', () => {
    $('evaluator').scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('evaluator').focus();
    $('evaluator').select();
  });
  sync.onChange(showPending);
  sync.startAutoSync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  $('evalDate').value = new Date().toISOString().slice(0, 10);
  F.evalDate = $('evalDate').value;
  $('evalDate').addEventListener('input', () => {
    F.evalDate = $('evalDate').value;
    ageFromDob();          // age is age *at assessment*, so it moves with the date
  });

  buildAdmin();
  showWho();              // the header line carries the centre too, and buildAdmin restores it
  buildModule1();
  buildModule2();
  buildModule3();
  buildModule4();
  buildModule5();

  document.querySelectorAll('.save').forEach((b) =>
    b.addEventListener('click', () => saveModule(b.dataset.save)));
}

function deviceId() {
  let id = localStorage.getItem('ppp.device.id');
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 8); localStorage.setItem('ppp.device.id', id); }
  return id;
}

/** Header line and rater attribution follow whatever is typed in the field. */
function showWho() {
  const parts = [centre && centre.name, who || 'evaluator not set'].filter(Boolean);
  $('who').textContent = parts.join(' · ');
  $('changeWho').textContent = who ? 'change' : 'add';
  sync.configure({ ...syncCfg, raterId: who || null });
}

/* ---------------- study serial ---------------- */

/**
 * The serial is allocated, never invented.
 *
 * Three centres enrol at once, so exactly one thing is allowed to hand out the
 * next number: the endpoint, inside the script lock it already takes for
 * writes. PPP-CH-0001 is genuinely the first child at Chuka. The enrolling
 * clinician taps once and writes the number on the paper form; the ward types
 * those four digits back hours later to open Modules 2-5, and the app checks
 * them against the workbook rather than against a checksum.
 *
 * This is the one thing in the app that needs a signal, and it is the one
 * thing that cannot honestly be done any other way.
 */
const NEW_PATIENT_LABEL = 'New patient — get the next number';

/** Numbers allocated in this session: expected to have no baseline row yet. */
const freshlyAllocated = new Set();

async function newPatient() {
  if (!centre) { toast('Pick the centre first'); return; }
  const btn = $('newPatient');
  btn.disabled = true;
  btn.textContent = 'Asking the workbook…';
  try {
    const studyNumber = await sync.allocateStudyNumber(centre.code);
    const parsed = parseSubjectId(studyNumber);
    freshlyAllocated.add(studyNumber);
    $('subjectSeq').value = parsed ? parsed.sequence : '';
    readSerial();
    toast(`${studyNumber} — write it on the paper form now`);
  } catch (err) {
    toast(err?.message === 'endpoint_stale'
      ? 'The endpoint is out of date — the new Code.gs has not been deployed yet'
      : 'No signal — study numbers can only be given out online');
  } finally {
    btn.disabled = false;
    btn.textContent = NEW_PATIENT_LABEL;
  }
}

function readSerial() {
  const input = $('subjectSeq');
  const digits = input.value;
  const note = $('subjectNote');

  $('serialPrefix').textContent = centre ? `PPP-${centre.code}-` : 'PPP-··-';
  input.className = 'mono';
  F.subjectId = '';

  if (!centre) {
    note.className = 'note warn';
    note.textContent = 'Pick the centre first — it is the middle of every study number.';
    return;
  }
  if (digits.length < 4) {
    note.className = 'note';
    note.textContent = digits
      ? 'Four digits, as written on the paper form.'
      : 'Tap “New patient” to enrol, or type the number from the paper form.';
    return;
  }

  let studyNumber;
  try {
    studyNumber = formatSubjectId(centre.code, digits);
  } catch {
    note.className = 'note bad';
    note.textContent = 'Numbering starts at 0001.';
    return;
  }

  F.subjectId = studyNumber;
  input.className = 'mono ok';
  note.className = 'note ok';
  ['m1', 'm2', 'm5'].forEach((mod) => markSaveButton(mod));

  if (freshlyAllocated.has(studyNumber)) {
    note.textContent = `${studyNumber} — new number. Write it on the paper form before the child leaves.`;
    return;
  }
  note.textContent = studyNumber;
  confirmAgainstWorkbook(studyNumber);
}

function enrolledHere() {
  try { return new Set(JSON.parse(localStorage.getItem(ENROLLED_KEY) || '[]')); } catch { return new Set(); }
}

function rememberEnrolled(studyNumber) {
  const set = enrolledHere();
  set.add(studyNumber);
  localStorage.setItem(ENROLLED_KEY, JSON.stringify([...set]));
}

/**
 * What the check character used to do, done against reality instead.
 *
 * A number typed off a paper form is checked for a baseline row. Missing means
 * a mistyped number far more often than an unenrolled child, and saying so
 * costs a second. "Unknown" — no signal, a dropped request — says nothing at
 * all: telling a nurse there is no such patient on the strength of a lost
 * request would be worse than silence. Neither answer blocks a save.
 */
let serialProbe = 0;
function confirmAgainstWorkbook(studyNumber) {
  if (enrolledHere().has(studyNumber)) { saySeen(studyNumber, 'yes'); return; }
  const probe = ++serialProbe;
  sync.enrolmentStatus(studyNumber)
    .then((status) => {
      if (probe !== serialProbe || F.subjectId !== studyNumber) return;
      if (status !== 'unknown') saySeen(studyNumber, status);
    })
    .catch(() => {});
}

function saySeen(studyNumber, status) {
  const note = $('subjectNote');
  if (status === 'yes') {
    note.className = 'note ok';
    note.textContent = `${studyNumber} — enrolled, baseline on file.`;
  } else {
    note.className = 'note warn';
    note.textContent = `${studyNumber} has no baseline row. Check the number on the form — or tap “New patient” if this child is not enrolled yet.`;
  }
}

/* ---------------- shared builders ---------------- */

/** Single-choice row. Stores into `onPick`. */
function optionRow(container, options, onPick, initial) {
  const box = $(container);
  box.replaceChildren();
  options.forEach((o) => {
    const label = typeof o === 'string' ? o : o.label;
    const value = typeof o === 'string' ? o : o.value;
    box.append(el('button', {
      type: 'button', class: value === initial ? 'on' : '', text: label,
      onclick: (e) => {
        [...box.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        onPick(value);
      },
    }));
  });
}

const yesNo = (container, onPick) =>
  optionRow(container, [{ label: 'No', value: false }, { label: 'Yes', value: true }], onPick);

/* ---------------- administrative ---------------- */

function buildAdmin() {
  centre = CONFIG.centres.find((c) => c.code === localStorage.getItem(CENTRE_KEY)) || null;
  optionRow('centre', CONFIG.centres.map((c) => ({ label: c.name, value: c.code })), (code) => {
    centre = CONFIG.centres.find((c) => c.code === code) || null;
    localStorage.setItem(CENTRE_KEY, code);
    showWho();
    readSerial();
  }, centre ? centre.code : undefined);

  const seq = $('subjectSeq');
  seq.addEventListener('input', () => {
    const digits = seq.value.replace(/\D/g, '').slice(0, 4);
    if (digits !== seq.value) seq.value = digits;
    readSerial();
  });
  // 31 typed in a hurry is the same child as 0031 on the form.
  seq.addEventListener('blur', () => {
    if (seq.value && seq.value.length < 4) { seq.value = seq.value.padStart(4, '0'); readSerial(); }
  });
  $('newPatient').addEventListener('click', newPatient);
  readSerial();

  const box = $('consent');
  params().formOptions.consent.forEach((label) => {
    box.append(el('button', {
      type: 'button', text: label,
      onclick: (e) => {
        if (F.consent.has(label)) F.consent.delete(label); else F.consent.add(label);
        e.currentTarget.classList.toggle('on');
      },
    }));
  });
}

/* ---------------- Module 1 ---------------- */

function buildModule1() {
  const o = params().formOptions;

  $('hospitalNo').addEventListener('input', () => {
    F.m1.hospital_number = $('hospitalNo').value.trim() || null;
  });
  $('dob').addEventListener('input', ageFromDob);
  $('ageMonths').addEventListener('input', () => {
    F.m1.age_months = num('ageMonths');
    applyRouting();
  });
  optionRow('sex', o.sex, (v) => { F.m1.sex = v; });
  optionRow('asa', o.asa, (v) => { F.m1.asa = v; });
  yesNo('chronicPain', (v) => { F.m1.chronic_pain = v; });

  const recalcBmi = () => {
    F.m1.weight_kg = num('weight');
    F.m1.height_cm = num('height');
    try {
      F.m1.bmi = bmi(F.m1.weight_kg, F.m1.height_cm);
      $('bmi').textContent = String(F.m1.bmi);
    } catch { F.m1.bmi = null; $('bmi').textContent = '—'; }
    updateOmePerKg();
    updateLaDose();
    totalOpioids();        // the per-kg morphine equivalent moves with the weight
    updateAnxiolytic();    // and so does the premedication dose
    updateSedativeDose();  // and the sedation dose
    drawAdjuvants();       // and every block adjuvant
    drawNonOpioids();      // and the non-opioids
    drawPacuPathways();    // and anything given in recovery
  };
  $('weight').addEventListener('input', recalcBmi);
  $('height').addEventListener('input', recalcBmi);

  drawMypas();
  buildAnxiolytic();
  // A VAS is marked blind: the caregiver sees an ungraduated line and their own
  // mark, never a number, because a visible score is anchored on and reported
  // rather than felt. The rater can reveal it afterwards to check it recorded;
  // moving the line re-hides it, so handing the phone to the next caregiver
  // never shows them the last one's answer. Nothing reads out until the line is
  // touched either — 50 is not a neutral default, it is the middle of the scale.
  const vas = $('caregiverVas');
  vas.addEventListener('input', () => {
    vas.classList.remove('unset');
    F.m1.caregiver_vas = Number(vas.value);
    vasRevealed = false;
    showVas();
  });
  $('vasReveal').addEventListener('click', () => { vasRevealed = !vasRevealed; showVas(); });
}

let vasRevealed = false;

function showVas() {
  const v = F.m1.caregiver_vas;
  const marked = v != null;
  $('vasValue').textContent = !marked ? 'Not yet marked' : vasRevealed ? `${v} / 100` : 'Marked ✓';
  $('vasReveal').hidden = !marked;
  $('vasReveal').textContent = vasRevealed ? 'hide the score' : 'show the score';
  $('vasBlindNote').textContent = vasRevealed
    ? 'Hide this again before the phone goes back to a caregiver.'
    : 'The number stays hidden so the caregiver marks the line, not a score.';
}

/**
 * Anxiolytic premedication, and what it worked out to per kilogram.
 *
 * Premedication is dosed per kilogram — 0.5 mg/kg of midazolam, 2 mcg/kg of
 * dexmedetomidine — so the mg on the chart is only half the record. The unit
 * differs by agent, and it travels with the number rather than being assumed
 * later. "No" is an answer and is recorded as one: a blank means nobody was
 * asked, which is not the same as a child who had none.
 */
function buildAnxiolytic() {
  const agents = params().anxiolytic.agents;
  let picked = null;

  yesNo('anxGiven', (given) => {
    F.m1.anxiolytic_given = given;
    $('anxDetail').hidden = !given;
    if (!given) {
      picked = null;
      $('anxAgent').replaceChildren();
      $('anxDose').value = '';
      $('anxDoseField').hidden = true;
      clearAnxiolyticDose();
      return;
    }
    optionRow('anxAgent', agents.map((a) => ({ label: a.name, value: a.name })), (name) => {
      picked = agents.find((a) => a.name === name) || null;
      F.m1.anxiolytic_agent = picked ? picked.name : null;
      F.m1.anxiolytic_dose_unit = picked ? picked.unit : null;
      $('anxUnit').textContent = picked ? `(${picked.unit})` : '';
      $('anxDose').value = '';
      $('anxDoseField').hidden = !picked;
      updateAnxiolytic();
    });
    updateAnxiolytic();
  });

  $('anxDose').addEventListener('input', () => {
    F.m1.anxiolytic_dose = num('anxDose');
    updateAnxiolytic();
  });
}

function clearAnxiolyticDose() {
  F.m1.anxiolytic_agent = null;
  F.m1.anxiolytic_dose = null;
  F.m1.anxiolytic_dose_unit = null;
  F.m1.anxiolytic_dose_per_kg = null;
  $('anxTotal').lastChild.replaceChildren('—');
  $('anxNote').textContent = '';
  $('anxNote').className = 'note';
}

function updateAnxiolytic() {
  const value = $('anxTotal').lastChild;
  const note = $('anxNote');
  const { anxiolytic_agent: agent, anxiolytic_dose: dose, anxiolytic_dose_unit: unit } = F.m1;
  const weight = F.m1.weight_kg;
  F.m1.anxiolytic_dose_per_kg = null;
  value.replaceChildren('—');

  if (!agent) {
    note.className = 'note';
    note.textContent = 'Which agent, and how much was given.';
    return;
  }
  if (dose == null || !(dose > 0)) {
    note.className = 'note';
    note.textContent = `${agent}, in ${unit}. The dose per kilogram works itself out.`;
    return;
  }
  if (!weight) {
    value.replaceChildren(`— ${unit}/kg`, el('span', { class: 'sub', text: `${dose} ${unit} given` }));
    note.className = 'note warn';
    note.textContent = 'Enter the weight above — premedication is dosed per kilogram, and without it that figure cannot be worked out.';
    return;
  }

  F.m1.anxiolytic_dose_per_kg = Math.round((dose / weight) * 1000) / 1000;
  value.replaceChildren(`${F.m1.anxiolytic_dose_per_kg} ${unit}/kg`,
    el('span', { class: 'sub', text: `${dose} ${unit} given` }));
  note.className = 'note ok';
  note.textContent = `${agent} ${dose} ${unit} in ${weight} kg.`;
}

/**
 * m-YPAS-SF, picked rather than typed.
 *
 * Four domains, each an ordinal 1..max — and the score is the mean of
 * (item / item maximum) across them, x100, which is not arithmetic anyone
 * should be doing between cases. The rater picks four lines; `mypasSfScore`
 * does the rest. The picks are submitted alongside the score, so the total is
 * always re-derivable from what was actually observed.
 *
 * Anchors are condensed for a phone screen; the domain maxima are the
 * instrument's own (vocalisation runs to 6, the rest to 4).
 */
const MYPAS = [
  ['activity', 'Activity', [
    'Looking around, curious, playing',
    'Not exploring, looks down, fidgets',
    'Unfocused, squirming, pushes things away',
    'Trying to get away, clinging, frantic',
  ]],
  ['vocalisation', 'Vocalisation', [
    'Talking, asking questions, babbling, laughing',
    'Whispers, baby talk, nods only',
    'Silent, no response',
    'Whimpering, moaning, crying without sound',
    'Crying, or saying “no”',
    'Loud sustained crying or screaming',
  ]],
  ['expressivity', 'Emotional expressivity', [
    'Happy, smiling, absorbed in play',
    'Neutral, no expression',
    'Worried, sad, tearful eyes',
    'Distressed, crying, eyes wide',
  ]],
  ['arousal', 'State of apparent arousal', [
    'Alert, looks around, watches what you do',
    'Withdrawn, quiet, still',
    'Vigilant, startles easily, tense',
    'Panicked, crying, pushing others away',
  ]],
];

function drawMypas() {
  const box = $('mypasItems');
  box.replaceChildren();
  MYPAS.forEach(([key, title, levels]) => {
    const row = el('div', { class: 'levels' });
    levels.forEach((text, i) => {
      const value = i + 1;            // m-YPAS domains are scored from 1, not 0
      row.append(el('button', {
        type: 'button', class: F.m1[`mypas_${key}`] === value ? 'on' : '',
        onclick: (e) => {
          F.m1[`mypas_${key}`] = value;
          [...row.children].forEach((c) => c.classList.remove('on'));
          e.currentTarget.classList.add('on');
          updateMypas();
        },
      }, el('b', { text: String(value) }), el('span', { text })));
    });
    box.append(el('div', { class: 'item' }, el('p', { class: 'item-q', text: title }), row));
  });
  updateMypas();
}

function updateMypas() {
  const out = $('mypasTotal').lastChild;
  const note = $('mypasNote');
  const domains = {};
  MYPAS.forEach(([key]) => {
    const v = F.m1[`mypas_${key}`];
    if (v != null) domains[key] = v;
  });

  const missing = MYPAS.length - Object.keys(domains).length;
  if (missing > 0) {
    F.m1.mypas_sf = null;
    out.textContent = '— / 100';
    note.className = 'note';
    note.textContent = `${missing} domain${missing === 1 ? '' : 's'} still to pick.`;
    return;
  }
  F.m1.mypas_sf = mypasSfScore(domains);
  out.textContent = `${F.m1.mypas_sf} / 100`;
  note.className = 'note ok';
  note.textContent = 'Worked out from the four picks. 22.92 is the floor — a completely calm child.';
}

const DOB_HINT = 'Works out the age. Stays on this phone — it is never saved or sent.';

/**
 * Date of birth in, completed months out.
 *
 * The birth date is a calculator input and nothing else: it is read straight
 * from the DOM, never written into `F`, never persisted, and never part of a
 * submission — `age_months` is the only thing that leaves the phone, which is
 * what keeps the workbook a non-identifiable dataset. Months are completed
 * calendar months (lib/age.js), not a day count divided by 30.4.
 */
function ageFromDob() {
  const dob = $('dob').value;
  const note = $('dobNote');
  const at = F.evalDate || new Date().toISOString().slice(0, 10);

  if (!dob) { note.className = 'note'; note.textContent = DOB_HINT; return; }

  let months;
  try {
    if (isFuture(dob, at)) {
      note.className = 'note bad';
      note.textContent = 'That birth date is after the assessment date. Check it.';
      return;
    }
    months = ageMonths(dob, at);
  } catch {
    note.className = 'note bad';
    note.textContent = 'That is not a real date.';
    return;
  }

  $('ageMonths').value = String(months);
  F.m1.age_months = months;
  note.className = 'note ok';
  note.textContent = `${ageLabel(dob, at)} on ${at}. Only the age in months is saved.`;
  applyRouting();
}

/** Age decides the scale, here and in Module 4. Nobody ticks a box for it. */
function applyRouting() {
  const months = F.m1.age_months;
  const note = $('toolNote');
  if (months == null || months < 0) {
    routed = null; note.hidden = true;
    $('m4Routing').textContent = 'Enter the child’s age in Module 1 and the right scale is chosen for you.';
    drawWardScales();
    return;
  }
  routed = selectInstrument({ ageMonths: months });
  note.hidden = false;
  note.textContent = `${monthsLabel(months)} — ${toolName(routed.tool)}`;
  $('m4Routing').textContent = `${monthsLabel(months)} — using ${toolName(routed.tool)}.`;
  drawWardScales();
  drawPacuPathways();     // recovery scores on the same instrument as the ward
}

const toolName = (tool) => ({
  [TOOLS.FLACC]: 'FLACC (watch the child)',
  [TOOLS.R_FLACC]: 'FLACC (watch the child)',
  [TOOLS.FPS_R]: 'FPS-R (child points at a face)',
  [TOOLS.NRS]: 'NRS (child gives a number 0–10)',
}[tool] || '');

/* ---------------- Module 2 ---------------- */

function buildModule2() {
  const o = params().formOptions;
  // The domain is four broad buckets, which is what the analysis groups on.
  // The operation itself is what a surgeon recognises the case by, so asking
  // for it the moment a bucket is picked costs a line and keeps the two
  // separable later.
  optionRow('domain', o.surgicalDomain, (v) => {
    F.m2.domain = v;
    $('procedureField').hidden = false;
  });
  $('procedure').addEventListener('input', () => {
    F.m2.procedure_name = $('procedure').value.trim() || null;
  });
  // Side is its own column rather than part of the operation text, so "left"
  // is countable instead of something an analysis has to read out of a string.
  optionRow('laterality', o.laterality, (v) => { F.m2.laterality = v; });
  optionRow('approach', o.approach, (v) => { F.m2.approach = v; });
  buildAnaesthesia(o);
  buildOpioids();
  buildNonOpioids();
  optionRow('guidance', o.guidance, (v) => { F.m2.guidance = v; });
  optionRow('laDrug', o.localAnaestheticDrugs, (v) => { F.m2.la_drug = v; updateLaDose(); });
  buildAdjuvants();

  // The block is named, not chosen from a list: "caudal + ilioinguinal" and
  // "left rectus sheath" are both real entries on the theatre form, and a
  // fixed list would force one of them into "PNB". An empty box means no
  // block, which is why the dose fields appear only once something is typed.
  $('blockName').addEventListener('input', () => {
    F.m2.block = $('blockName').value.trim() || null;
    $('blockDetail').hidden = !F.m2.block;
    updateLaDose();
  });

  $('incision').addEventListener('input', () => { F.m2.incision = num('incision'); });

  ['anaesStart', 'anaesEnd', 'surgStart', 'surgEnd'].forEach((id) => {
    const input = $(id);
    input.addEventListener('input', updateTimes);
    // Tapping the field asks the browser for its own time picker. Chrome and
    // the phones open a wheel or a clock; Safari on a Mac has none and simply
    // ignores this, which is why Now exists beside every one of them.
    input.addEventListener('click', () => {
      if (typeof input.showPicker === 'function') {
        try { input.showPicker(); } catch { /* not allowed here; typing still works */ }
      }
    });
  });
  document.querySelectorAll('.nowbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.now);
      const now = new Date();
      input.value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      updateTimes();
    });
  });
  updateTimes();

  ['laConc', 'laVol'].forEach((id) =>
    $(id).addEventListener('input', () => { F.m2[snake(id)] = num(id); updateLaDose(); }));
}

const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/**
 * The one number worth checking as it is typed. An entry over the ceiling is
 * far more often a decimal slip than a real overdose, and catching it before
 * the block is given is the whole point.
 */
/**
 * Block adjuvants, each per kilogram in its own right.
 *
 * Caudals rarely go in as plain local: clonidine, dexmedetomidine or an opioid
 * rides along, and each is dosed per kilogram against its own ceiling. There
 * is deliberately no combined figure — adding mcg of clonidine to mg of
 * morphine would produce a number that means nothing.
 *
 * Adrenaline is the exception and carries no dose. It is here because it
 * raises the lidocaine ceiling from 5 to 7 mg/kg, and that ceiling is the one
 * thing this form refuses a save over. Recording it as an adjuvant is what
 * makes the refusal correct rather than merely cautious.
 */
const adjuvantLog = [];

function buildAdjuvants() {
  const adjuvants = params().localAnaesthetic.adjuvants;
  let picked = null;

  optionRow('adjAgent', adjuvants.map((a) => ({ label: a.name, value: a.name })), (name) => {
    picked = adjuvants.find((a) => a.name === name) || null;
    if (picked && picked.unit === null) {
      // Adrenaline: no dose to ask for, so it goes straight into the log.
      if (!adjuvantLog.some((d) => d.drug === picked.name)) {
        adjuvantLog.push({ drug: picked.name, amount: null, unit: null });
      }
      $('adjDoseField').hidden = true;
      drawAdjuvants();
      return;
    }
    $('adjUnit').textContent = picked ? `(${picked.unit})` : '';
    $('adjDose').value = '';
    $('adjDoseField').hidden = !picked;
  });

  $('addAdj').addEventListener('click', () => {
    const amount = num('adjDose');
    if (!picked) { toast('Pick the adjuvant first'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    adjuvantLog.push({ drug: picked.name, amount, unit: picked.unit });
    $('adjDose').value = '';
    drawAdjuvants();
  });

  drawAdjuvants();
}

function drawAdjuvants() {
  const list = $('adjList');
  const weight = F.m1.weight_kg;
  list.replaceChildren();

  adjuvantLog.forEach((d, i) => {
    const perKg = (d.amount != null && weight)
      ? `${Math.round((d.amount / weight) * 1000) / 1000} ${d.unit}/kg`
      : null;
    list.append(el('li', {},
      el('span', { text: d.amount == null ? d.drug : `${d.drug} ${d.amount} ${d.unit}` }),
      el('span', { class: 'muted', text: perKg || (d.amount == null ? 'raises the ceiling' : 'needs weight') }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { adjuvantLog.splice(i, 1); drawAdjuvants(); },
      })));
  });

  // Rebuild every adjuvant column so a removed line leaves nothing behind.
  params().localAnaesthetic.adjuvants.forEach((a) => {
    delete F.m2[`adjuvant_${a.name.toLowerCase()}_${a.unit || 'given'}`];
    delete F.m2[`adjuvant_${a.name.toLowerCase()}_per_kg`];
  });
  for (const d of adjuvantLog) {
    const key = d.drug.toLowerCase();
    if (d.amount == null) { F.m2[`adjuvant_${key}_given`] = true; continue; }
    F.m2[`adjuvant_${key}_${d.unit}`] = d.amount;
    if (weight) F.m2[`adjuvant_${key}_per_kg`] = Math.round((d.amount / weight) * 1000) / 1000;
  }
  F.m2.adjuvants = adjuvantLog.length
    ? adjuvantLog.map((d) => (d.amount == null ? d.drug : `${d.drug} ${d.amount} ${d.unit}`)).join('; ')
    : null;

  const note = $('adjNote');
  if (!adjuvantLog.length) {
    note.className = 'note';
    note.textContent = 'Anything added to the solution. Each is worked out per kilogram on its own.';
  } else if (!weight && adjuvantLog.some((d) => d.amount != null)) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to get these per kilogram.';
  } else {
    note.className = 'note ok';
    note.textContent = F.m2.adjuvants;
  }

  updateLaDose();     // adrenaline moves the lidocaine ceiling
}

/**
 * Per cent, millilitres and a weight give the dose per kilogram.
 *
 * Stated per kilogram first, for the same reason as the opioid total: 15 mg of
 * bupivacaine is routine in a teenager and an overdose in an infant. The
 * ceiling check is the one place this app refuses a save outright, because an
 * entry over the maximum is far more often a decimal slip in the form than a
 * dose anyone actually gave.
 */
function updateLaDose() {
  const note = $('laNote');
  const value = $('laTotal').lastChild;
  const { la_drug: drug, la_conc: conc, la_vol: vol } = F.m2;
  const weight = F.m1.weight_kg;

  F.m2.la_mg = null;
  F.m2.la_mg_per_kg = null;
  F.m2.la_pct_of_max = null;
  F.m2.la_verdict = null;
  value.replaceChildren('—');

  if (!drug || !conc || !vol) {
    note.className = 'note';
    note.textContent = 'Agent, per cent and volume give the dose per kilogram.';
    return;
  }
  if (!weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 — the ceiling is per kilogram, so without it the dose cannot be checked.';
    return;
  }

  try {
    const d = localAnaestheticDose({
      agent: drug.toLowerCase(), concentrationPct: conc, volumeMl: vol, weightKg: weight,
      withEpinephrine: adjuvantLog.some((a) => a.drug === 'Adrenaline'),
    });
    F.m2.la_mg = d.mg;
    F.m2.la_mg_per_kg = d.mgPerKg;
    F.m2.la_pct_of_max = d.pctOfMax;
    F.m2.la_verdict = d.verdict;

    value.replaceChildren(`${d.mgPerKg} mg/kg`,
      el('span', { class: 'sub', text: `${d.mg} mg total · ${d.pctOfMax}% of maximum` }));
    note.textContent = d.message || `${d.pctOfMax}% of the ${d.maxMgPerKg} mg/kg maximum.`;
    note.className = `note ${d.verdict === 'block' ? 'bad' : d.verdict === 'warn' ? 'warn' : 'ok'}`;
  } catch (err) {
    note.className = 'note bad';
    note.textContent = String(err.message || err);
  }
}

/**
 * Anaesthesia, asked the way it is given.
 *
 * General or sedation. General asks gas or TIVA first; sedation goes straight
 * to the drug, because it is given as a drug rather than as a circuit. Either
 * way it ends at an agent and a dose — in the unit that agent is actually
 * charted in. A volatile is a fraction of MAC, a propofol infusion is
 * mg/kg/hr, a ketamine one is mcg/kg/min, and the unit is stored beside the
 * number rather than assumed at analysis time. A rate recorded without its
 * unit is how a tenfold error survives to the end of a study.
 *
 * Every branch clears what it hid. A case switched from TIVA to gas must not
 * keep a propofol rate in mg/kg/hr sitting in the row underneath a
 * sevoflurane percentage.
 */
function buildAnaesthesia(o) {
  optionRow('anaesType', o.anaesthesiaType, (type) => {
    F.m2.anaesthesia_type = type;
    F.m2.maintenance_route = null;
    [...$('maintRoute').children].forEach((b) => b.classList.remove('on'));
    clearAgent();

    if (type === 'General') {
      // Gas or TIVA first; the agent list depends on the answer.
      $('maintRouteField').hidden = false;
      $('agentField').hidden = true;
      return;
    }
    // Sedation is given as a drug rather than as a circuit, so there is no
    // gas-or-TIVA question to ask — straight to which drug, and how much. Its
    // own list, because midazolam and dexmedetomidine sedate but neither
    // maintains a general anaesthetic on its own.
    $('maintRouteField').hidden = true;
    showAgents('Sedative', o.sedativeAgent, 'sedation');
  });

  optionRow('maintRoute', o.maintenanceRoute, (route) => {
    F.m2.maintenance_route = route;
    clearAgent();
    showAgents(route === 'TIVA' ? 'Infusion' : 'Volatile agent',
      route === 'TIVA' ? o.infusionAgent : o.gasAgent, 'maintenance');
  });

  $('anaesDose').addEventListener('input', () => {
    F.m2.anaes_dose = num('anaesDose');
    updateSedativeDose();
  });
}

function showAgents(label, list, mode) {
  doseMode = mode;
  $('agentLabel').textContent = label;
  $('agentField').hidden = false;
  optionRow('agent', list, pickAgent);
}

/**
 * Maintenance is charted as a rate; sedation is charted as an amount.
 *
 * A propofol infusion runs at mg/kg/hr and is already per kilogram, so there
 * is nothing to work out. A sedation dose is written on the chart as the
 * milligrams that went in, and the figure that compares between children — and
 * that the protocol is written in — is mg/kg. So the two paths take different
 * units for the same drug, and only one of them divides by weight.
 */
function pickAgent(agent) {
  const cfg = params().anaesthesia;
  const unit = doseMode === 'sedation'
    ? cfg.sedativeDoseUnits[agent]
    : cfg.doseUnits[agent];

  F.m2.anaes_agent = agent;
  F.m2.anaes_dose_unit = unit || null;
  F.m2.anaes_dose = null;
  $('anaesDose').value = '';
  $('doseUnit').textContent = unit ? `(${unit})` : '';
  $('doseNote').textContent = unit
    ? `As charted: ${agent} in ${unit}.`
    : `No charting unit is declared for ${agent}.`;
  $('doseNote').className = unit ? 'note' : 'note warn';
  $('doseField').hidden = false;
  updateSedativeDose();
}

function updateSedativeDose() {
  const row = $('sedTotal');
  const value = row.lastChild;
  F.m2.anaes_dose_per_kg = null;

  if (doseMode !== 'sedation' || !F.m2.anaes_agent) { row.hidden = true; return; }
  row.hidden = false;

  const { anaes_dose: dose, anaes_dose_unit: unit, anaes_agent: agent } = F.m2;
  const weight = F.m1.weight_kg;
  if (dose == null || !(dose > 0)) { value.replaceChildren('—'); return; }

  if (!weight) {
    value.replaceChildren(`— ${unit}/kg`, el('span', { class: 'sub', text: `${dose} ${unit} given` }));
    $('doseNote').className = 'note warn';
    $('doseNote').textContent = 'Enter the weight in Module 1 — sedation is dosed per kilogram.';
    return;
  }

  F.m2.anaes_dose_per_kg = Math.round((dose / weight) * 1000) / 1000;
  value.replaceChildren(`${F.m2.anaes_dose_per_kg} ${unit}/kg`,
    el('span', { class: 'sub', text: `${dose} ${unit} given` }));
  $('doseNote').className = 'note ok';
  $('doseNote').textContent = `${agent} ${dose} ${unit} in ${weight} kg.`;
}

function clearAgent() {
  F.m2.anaes_agent = null;
  F.m2.anaes_dose = null;
  F.m2.anaes_dose_unit = null;
  F.m2.anaes_dose_per_kg = null;
  $('sedTotal').hidden = true;
  $('anaesDose').value = '';
  $('agent').replaceChildren();
  $('agentField').hidden = true;
  $('doseField').hidden = true;
}

/**
 * Non-opioid analgesia, with the route on the record.
 *
 * Paracetamol and diclofenac go in either intravenously or rectally, and the
 * two are not the same event: the onset differs, the dose differs, and a
 * suppository given at induction is a different analgesic plan from an
 * infusion at closure. "IV paracetamol" as a single box quietly threw that
 * away. Each dose is per kilogram, which is how these are prescribed in
 * children.
 */
const nonOpioidLog = [];

function buildNonOpioids() {
  const { agents, routes } = params().nonOpioids;
  let drug = null;
  let route = null;

  optionRow('noDrug', agents.map((a) => ({ label: a.name, value: a.name })), (name) => {
    drug = name;
    route = null;
    $('noRouteField').hidden = false;
    $('noDoseField').hidden = true;
    optionRow('noRoute', routes, (r) => {
      route = r;
      $('noDose').value = '';
      $('noDoseField').hidden = false;
    });
  });

  $('addNonOpioid').addEventListener('click', () => {
    const amount = num('noDose');
    if (!drug) { toast('Pick the drug first'); return; }
    if (!route) { toast('IV or PR?'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    nonOpioidLog.push({ drug, route, amount, unit: 'mg' });
    $('noDose').value = '';
    drawNonOpioids();
  });

  drawNonOpioids();
}

function drawNonOpioids() {
  const list = $('noList');
  const weight = F.m1.weight_kg;
  list.replaceChildren();

  nonOpioidLog.forEach((d, i) => {
    const perKg = weight ? `${Math.round((d.amount / weight) * 1000) / 1000} mg/kg` : 'needs weight';
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.route} ${d.amount} mg` }),
      el('span', { class: 'muted', text: perKg }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { nonOpioidLog.splice(i, 1); drawNonOpioids(); },
      })));
  });

  // Rebuild every column: drug and route together, because the same drug by a
  // different route is a different administration.
  const { agents, routes } = params().nonOpioids;
  agents.forEach((a) => routes.forEach((r) => {
    const key = `${a.name.toLowerCase()}_${r.toLowerCase()}`;
    delete F.m2[`nonopioid_${key}_mg`];
    delete F.m2[`nonopioid_${key}_per_kg`];
  }));

  const totals = new Map();
  for (const d of nonOpioidLog) {
    const key = `${d.drug.toLowerCase()}_${d.route.toLowerCase()}`;
    totals.set(key, (totals.get(key) || 0) + d.amount);
  }
  for (const [key, amount] of totals) {
    F.m2[`nonopioid_${key}_mg`] = Math.round(amount * 1000) / 1000;
    if (weight) F.m2[`nonopioid_${key}_per_kg`] = Math.round((amount / weight) * 1000) / 1000;
  }
  F.m2.non_opioids = nonOpioidLog.length
    ? nonOpioidLog.map((d) => `${d.drug} ${d.route} ${d.amount} mg`).join('; ')
    : null;

  const note = $('noNote');
  if (!nonOpioidLog.length) {
    note.className = 'note';
    note.textContent = 'Paracetamol, diclofenac, ketorolac or ketamine — and whether it went in IV or PR.';
  } else if (!weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to get these per kilogram.';
  } else {
    note.className = 'note ok';
    note.textContent = F.m2.non_opioids;
  }
}

/**
 * Intraoperative opioids, one dose at a time.
 *
 * A single "total fentanyl" box asks theatre to do arithmetic mid-case and
 * throws away when each dose was given. Every administration goes in on its
 * own line instead, and the per-drug totals and the cumulative morphine
 * equivalent fall out of the log.
 *
 * Conversion is route-aware and unit-strict — fentanyl is per mcg, the rest
 * per mg — and a drug with no declared IV factor is deliberately NOT converted
 * to zero. It is totalled in its own units and named as excluded, because a
 * silent zero would understate the opioid load of every child who got it.
 */
const ROUTE = 'IV';           // theatre opioids are given intravenously
/** 'maintenance' charts a rate; 'sedation' charts an amount given. */
let doseMode = 'maintenance';
const opioidLog = [];

function buildOpioids() {
  const agents = params().opioids.intraoperative.agents;
  let picked = null;

  optionRow('opioidDrug', agents.map((a) => ({ label: a.name, value: a.name })), (name) => {
    picked = agents.find((a) => a.name === name) || null;
    $('opioidUnit').textContent = picked ? `(${picked.unit})` : '';
    $('opioidDoseField').hidden = !picked;
    $('opioidDose').focus();
  });

  $('addDose').addEventListener('click', () => {
    const amount = num('opioidDose');
    if (!picked) { toast('Pick the drug first'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    opioidLog.push({ drug: picked.name, amount, unit: picked.unit });
    $('opioidDose').value = '';
    drawDoses();
  });

  drawDoses();
}

function drawDoses() {
  const list = $('doseList');
  list.replaceChildren();
  opioidLog.forEach((d, i) => {
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.amount} ${d.unit}` }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { opioidLog.splice(i, 1); drawDoses(); },
      })));
  });
  totalOpioids();
}

function totalOpioids() {
  const agents = params().opioids.intraoperative.agents;
  const perDrug = new Map();
  const unconverted = new Set();
  let mme = 0;

  for (const d of opioidLog) {
    perDrug.set(d.drug, (perDrug.get(d.drug) || 0) + d.amount);
    if (resolveMmeKey(d.drug, ROUTE)) {
      mme += doseMme({ drug: d.drug, route: ROUTE, amount: d.amount, unit: d.unit });
    } else {
      unconverted.add(d.drug);
    }
  }

  // Rebuild every per-drug column so a removed dose cannot leave a stale total.
  agents.forEach((a) => { delete F.m2[`opioid_${a.name.toLowerCase()}_${a.unit}`]; });
  for (const [drug, amount] of perDrug) {
    const agent = agents.find((a) => a.name === drug);
    F.m2[`opioid_${drug.toLowerCase()}_${agent.unit}`] = Math.round(amount * 1000) / 1000;
  }

  const given = [...perDrug].map(([drug, amount]) =>
    `${drug} ${Math.round(amount * 1000) / 1000} ${agents.find((a) => a.name === drug).unit}`);

  F.m2.opioid_doses = opioidLog.map((d) => `${d.drug} ${d.amount} ${d.unit}`).join('; ') || null;
  F.m2.opioid_dose_count = opioidLog.length;
  F.m2.opioid_route = opioidLog.length ? ROUTE : null;
  F.m2.opioid_mme_mg = opioidLog.length ? Math.round(mme * 1000) / 1000 : null;
  F.m2.opioid_mme_excluded = unconverted.size ? [...unconverted].join('; ') : null;

  const weight = F.m1.weight_kg;
  F.m2.opioid_mme_per_kg = (F.m2.opioid_mme_mg != null && weight)
    ? Math.round((F.m2.opioid_mme_mg / weight) * 1000) / 1000
    : null;

  $('opioidGiven').lastChild.textContent = given.length ? given.join(' · ') : 'nothing yet';

  // Per kilogram is the headline, because 12 mg of morphine equivalent means
  // one thing in a 6 kg infant and another in a 40 kg teenager, and the
  // comparison across children is the whole point of recording it. The
  // absolute figure stays visible underneath — it is what the chart says, and
  // it is what the per-kg number is recomputed from.
  const value = $('opioidMme').lastChild;
  value.replaceChildren();
  if (!opioidLog.length) {
    value.append('—');
  } else if (F.m2.opioid_mme_per_kg != null) {
    value.append(`${F.m2.opioid_mme_per_kg} mg/kg`,
      el('span', { class: 'sub', text: `${F.m2.opioid_mme_mg} mg total` }));
  } else {
    value.append('— mg/kg',
      el('span', { class: 'sub', text: `${F.m2.opioid_mme_mg} mg total` }));
  }

  const note = $('opioidNote');
  const needsWeight = opioidLog.length && F.m2.opioid_mme_mg != null && F.m2.opioid_mme_per_kg == null;
  if (unconverted.size) {
    note.className = 'note warn';
    note.textContent = `${[...unconverted].join(' and ')} has no published IV conversion in params, so it is recorded and totalled but left out of the morphine equivalent.`;
  } else if (needsWeight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 — without it the dose cannot be expressed per kilogram, which is the figure that compares between children.';
  } else {
    note.className = 'note';
    note.textContent = 'Add each dose as it is given. The totals and the morphine equivalent work themselves out.';
  }
}

/**
 * Theatre times in, durations out.
 *
 * Nobody subtracts 08:40 from 09:55 between cases, and a duration typed by
 * hand is one nobody can check afterwards — the times it came from are gone.
 * Both are recorded: the four clock times as written on the anaesthetic chart,
 * and the two durations derived from them, so the arithmetic stays auditable
 * and a mistyped time is findable later.
 */
function updateTimes() {
  const times = {
    anaesStart: $('anaesStart').value,
    anaesEnd: $('anaesEnd').value,
    surgStart: $('surgStart').value,
    surgEnd: $('surgEnd').value,
  };
  Object.assign(F.m2, {
    anaes_start: times.anaesStart || null,
    anaes_end: times.anaesEnd || null,
    surg_start: times.surgStart || null,
    surg_end: times.surgEnd || null,
  });

  const anaes = minutesBetween(times.anaesStart, times.anaesEnd);
  const surg = minutesBetween(times.surgStart, times.surgEnd);
  F.m2.anaes_duration_min = anaes;
  F.m2.surg_duration_min = surg;

  $('anaesTotal').lastChild.textContent = durationLabel(anaes);
  $('surgTotal').lastChild.textContent = durationLabel(surg);

  // Knife after induction, closure before the child is woken. Where that does
  // not hold a time was mistyped — say so, and record it anyway.
  const note = $('timesNote');
  if (surgeryWithinAnaesthesia(times) === false) {
    note.className = 'note warn';
    note.textContent = 'The operation falls outside the anaesthetic. Check the four times.';
  } else if (anaes != null && surg != null) {
    note.className = 'note ok';
    note.textContent = `${durationLabel(anaes - surg)} of anaesthesia outside the operation.`;
  } else {
    note.className = 'note';
    note.textContent = 'Times as written on the anaesthetic chart. The durations work themselves out.';
  }
}

/* ---------------- Module 3: PAED ---------------- */

const PAED_ITEMS = [
  ['eye_contact', 'Child makes eye contact with observer', true],
  ['purposeful', 'Actions are purposeful', true],
  ['aware', 'Child is aware of surroundings', true],
  ['restless', 'Child is restless (thrashing, kicking)', false],
  ['inconsolable', 'Child is inconsolable', false],
];
const PAED_WORDS = ['Not at all', 'Just a little', 'Quite a bit', 'Very much', 'Extremely'];

function buildModule3() {
  const tabs = $('paedTabs');
  params().paedSchedule.timepoints.forEach((tp) => {
    tabs.append(el('button', {
      type: 'button', class: tp.id === F.paedTab ? 'on' : '', 'data-tp': tp.id, text: tp.label,
      onclick: () => { F.paedTab = tp.id; refreshPaedTabs(); drawPaedItems(); },
    }));
  });
  drawPaedItems();
  buildPacuPathways();
}

/* ---------------- PACU: what the PAED points at ---------------- */

/**
 * A PAED score is a question, not an answer, and the two answers need
 * different things done.
 *
 * Pain: score it on the instrument the child's age selected — the same one the
 * ward uses — and record what was given for it, converted to morphine
 * equivalents exactly as intraoperative opioids are, so a child's opioid load
 * can be added up across theatre, recovery and the ward.
 *
 * Delirium: the wrong answer is more opioid, so that list holds none. Calming
 * first; if something was given, it was dexmedetomidine, clonidine or ketamine,
 * and it is recorded per kilogram.
 *
 * Everything here is per timepoint. P0, P30 and P60 are three separate
 * assessments of the same child and a rescue dose belongs to exactly one.
 */
const pacuLog = {};
const pacuStore = (tp) => (pacuLog[tp] ||= { rescue: [], delirium: [] });

function buildPacuPathways() {
  const opioids = params().opioids.intraoperative.agents;
  const nonOpioids = params().nonOpioids;
  const edAgents = params().pacuDelirium.agents;
  let opioid = null;
  let nonOpioid = null;
  let route = null;
  let edAgent = null;

  optionRow('rescueOpioid', opioids.map((a) => ({ label: a.name, value: a.name })), (name) => {
    opioid = opioids.find((a) => a.name === name) || null;
    $('rescueOpioidUnit').textContent = opioid ? `(${opioid.unit})` : '';
    $('rescueOpioidDose').value = '';
    $('rescueOpioidDoseField').hidden = !opioid;
  });
  $('addRescueOpioid').addEventListener('click', () => {
    const amount = num('rescueOpioidDose');
    if (!opioid) { toast('Pick the opioid first'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    pacuStore(F.paedTab).rescue.push({ drug: opioid.name, route: 'IV', amount, unit: opioid.unit, opioid: true });
    $('rescueOpioidDose').value = '';
    drawRescue();
  });

  optionRow('rescueNonOpioid', nonOpioids.agents.map((a) => ({ label: a.name, value: a.name })), (name) => {
    nonOpioid = name;
    route = null;
    $('rescueRouteField').hidden = false;
    $('rescueNonOpioidDoseField').hidden = true;
    optionRow('rescueRoute', nonOpioids.routes, (r) => {
      route = r;
      $('rescueNonOpioidDose').value = '';
      $('rescueNonOpioidDoseField').hidden = false;
    });
  });
  $('addRescueNonOpioid').addEventListener('click', () => {
    const amount = num('rescueNonOpioidDose');
    if (!nonOpioid) { toast('Pick the drug first'); return; }
    if (!route) { toast('IV or PR?'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    pacuStore(F.paedTab).rescue.push({ drug: nonOpioid, route, amount, unit: 'mg', opioid: false });
    $('rescueNonOpioidDose').value = '';
    drawRescue();
  });

  optionRow('edAgent', edAgents.map((a) => ({ label: a.name, value: a.name })), (name) => {
    edAgent = edAgents.find((a) => a.name === name) || null;
    $('edUnit').textContent = edAgent ? `(${edAgent.unit})` : '';
    $('edDose').value = '';
    $('edDoseField').hidden = !edAgent;
  });
  $('addEd').addEventListener('click', () => {
    const amount = num('edDose');
    if (!edAgent) { toast('Pick the agent first'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    pacuStore(F.paedTab).delirium.push({ drug: edAgent.name, amount, unit: edAgent.unit });
    $('edDose').value = '';
    drawDelirium();
  });
}

function drawRescue() {
  const store = (F.paed[F.paedTab] ||= {});
  const log = pacuStore(F.paedTab).rescue;
  const weight = F.m1.weight_kg;
  const list = $('rescueList');
  list.replaceChildren();

  let mme = 0;
  const unconverted = new Set();

  log.forEach((d, i) => {
    let per = weight ? `${Math.round((d.amount / weight) * 1000) / 1000} ${d.unit}/kg` : 'needs weight';
    if (d.opioid) {
      if (resolveMmeKey(d.drug, d.route)) {
        mme += doseMme({ drug: d.drug, route: d.route, amount: d.amount, unit: d.unit });
      } else {
        unconverted.add(d.drug);
        per += ' · not converted';
      }
    }
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.route} ${d.amount} ${d.unit}` }),
      el('span', { class: 'muted', text: per }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { log.splice(i, 1); drawRescue(); },
      })));
  });

  const anyOpioid = log.some((d) => d.opioid);
  store.rescue_doses = log.length ? log.map((d) => `${d.drug} ${d.route} ${d.amount} ${d.unit}`).join('; ') : null;
  store.rescue_dose_count = log.length;
  store.rescue_mme_mg = anyOpioid ? Math.round(mme * 1000) / 1000 : null;
  store.rescue_mme_per_kg = (store.rescue_mme_mg != null && weight)
    ? Math.round((store.rescue_mme_mg / weight) * 1000) / 1000 : null;
  store.rescue_mme_excluded = unconverted.size ? [...unconverted].join('; ') : null;

  const value = $('rescueMme').lastChild;
  value.replaceChildren();
  if (!anyOpioid) {
    value.append('—');
  } else if (store.rescue_mme_per_kg != null) {
    value.append(`${store.rescue_mme_per_kg} mg/kg`,
      el('span', { class: 'sub', text: `${store.rescue_mme_mg} mg total` }));
  } else {
    value.append('— mg/kg', el('span', { class: 'sub', text: `${store.rescue_mme_mg} mg total` }));
  }

  const note = $('rescueNote');
  if (unconverted.size) {
    note.className = 'note warn';
    note.textContent = `${[...unconverted].join(' and ')} has no published IV conversion, so it is recorded but left out of the morphine equivalent.`;
  } else if (anyOpioid && !weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to express this per kilogram.';
  } else {
    note.className = 'note';
    note.textContent = 'Everything given for pain at this timepoint. Opioids are added to the morphine equivalent.';
  }
}

function drawDelirium() {
  const store = (F.paed[F.paedTab] ||= {});
  const log = pacuStore(F.paedTab).delirium;
  const weight = F.m1.weight_kg;
  const list = $('edList');
  list.replaceChildren();

  log.forEach((d, i) => {
    const per = weight ? `${Math.round((d.amount / weight) * 1000) / 1000} ${d.unit}/kg` : 'needs weight';
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.amount} ${d.unit}` }),
      el('span', { class: 'muted', text: per }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { log.splice(i, 1); drawDelirium(); },
      })));
  });

  params().pacuDelirium.agents.forEach((a) => {
    delete store[`delirium_${a.name.toLowerCase()}_${a.unit}`];
    delete store[`delirium_${a.name.toLowerCase()}_per_kg`];
  });
  for (const d of log) {
    const key = d.drug.toLowerCase();
    store[`delirium_${key}_${d.unit}`] = d.amount;
    if (weight) store[`delirium_${key}_per_kg`] = Math.round((d.amount / weight) * 1000) / 1000;
  }
  store.delirium_doses = log.length ? log.map((d) => `${d.drug} ${d.amount} ${d.unit}`).join('; ') : null;

  const note = $('edNote');
  if (!log.length) {
    note.className = 'note';
    note.textContent = 'Calming and reassurance first. Record a drug only if one was given.';
  } else if (!weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to express these per kilogram.';
  } else {
    note.className = 'note ok';
    note.textContent = store.delirium_doses;
  }
}

function drawPacuPathways() {
  const store = F.paed[F.paedTab] || {};
  const verdict = $('paedVerdict');

  if (store.total == null) {
    $('painPath').hidden = true;
    $('deliriumPath').hidden = true;
    verdict.textContent = '';
    verdict.className = 'note';
    return;
  }

  const { pathway, message } = pacuPathway({
    paedTotal: store.total,
    purposeful: store.purposeful ?? null,
    eyeContact: store.eye_contact ?? null,
  });
  store.pacu_pathway = pathway;
  verdict.textContent = message;
  verdict.className = `note ${pathway === 'delirium' ? 'warn' : pathway === 'pain' ? 'ok' : ''}`;

  $('painPath').hidden = pathway !== 'pain';
  $('deliriumPath').hidden = pathway !== 'delirium';

  if (pathway === 'pain') {
    $('pacuScaleLabel').textContent = `Pain score — ${toolName(routed ? routed.tool : null) || 'enter the age in Module 1'}`;
    paintScale($('pacuScale'), store, 'pacu_pain');
    drawRescue();
  }
  if (pathway === 'delirium') drawDelirium();
}

function refreshPaedTabs() {
  markSaveButton('m3', F.paedTab);
  drawPacuPathways();
  [...$('paedTabs').children].forEach((b) => {
    b.classList.toggle('on', b.dataset.tp === F.paedTab);
    b.classList.toggle('filled', Boolean(F.paed[b.dataset.tp]?.saved));
  });
}

function drawPaedItems() {
  const store = (F.paed[F.paedTab] ||= {});
  const box = $('paedItems');
  box.replaceChildren();

  PAED_ITEMS.forEach(([key, question, reverse]) => {
    const row = el('div', { class: 'item-scale' });
    // The response scale runs the same way for every item — "not at all" to
    // "extremely". Items 1-3 are reverse-scored by the app, never by the
    // person holding the phone. Hand-reversal is the classic PAED error.
    PAED_WORDS.forEach((word, response) => {
      const shown = reverse ? 4 - response : response;
      row.append(el('button', {
        type: 'button', class: store[key] === response ? 'on' : '',
        onclick: (e) => {
          store[key] = response;
          [...row.children].forEach((c) => c.classList.remove('on'));
          e.currentTarget.classList.add('on');
          updatePaedTotal();
        },
      }, el('b', { text: String(shown) }), el('span', { text: word })));
    });
    box.append(el('div', { class: 'item' }, el('p', { class: 'item-q', text: question }), row));
  });
  updatePaedTotal();
}

function updatePaedTotal() {
  const store = F.paed[F.paedTab] || {};
  const out = $('paedTotal').lastChild;
  try {
    store.total = paedTotal(store);
    out.textContent = `${store.total} / 20`;
  } catch {
    store.total = null;
    out.textContent = '— / 20';
  }
  // The score is a question; what follows is the answer it points at.
  drawPacuPathways();
}

/* ---------------- Module 4: ward pain ---------------- */

function buildModule4() {
  const tabs = $('wardTabs');
  params().assessmentSchedule.timepoints.forEach((tp) => {
    tabs.append(el('button', {
      type: 'button', class: tp.id === F.wardTab ? 'on' : '', 'data-tp': tp.id, text: tp.label,
      onclick: () => { F.wardTab = tp.id; refreshWardTabs(); drawWardScales(); },
    }));
  });
  yesNo('rebound', (v) => { (F.ward[F.wardTab] ||= {}).rebound = v; });
  yesNo('rescue', (v) => { (F.ward[F.wardTab] ||= {}).rescue = v; });
  drawWardScales();
}

function refreshWardTabs() {
  markSaveButton('m4', F.wardTab);
  [...$('wardTabs').children].forEach((b) => {
    b.classList.toggle('on', b.dataset.tp === F.wardTab);
    b.classList.toggle('filled', Boolean(F.ward[b.dataset.tp]?.saved));
  });
  const cur = F.ward[F.wardTab] || {};
  ['rebound', 'rescue'].forEach((id) => {
    const box = $(id);
    [...box.children].forEach((c, i) => c.classList.toggle('on', cur[id] === (i === 1)));
  });
}

function drawWardScales() {
  const store = (F.ward[F.wardTab] ||= {});
  paintScale($('restScale'), store, 'rest');
  paintScale($('moveScale'), store, 'move');
}

function paintScale(container, store, which) {
  container.replaceChildren();
  if (!routed) {
    container.append(el('p', { class: 'note', text: 'Enter age in Module 1 first.' }));
    return;
  }
  if (routed.tool === TOOLS.FLACC || routed.tool === TOOLS.R_FLACC) {
    container.append(flaccUI(store, which));
  } else if (routed.tool === TOOLS.FPS_R) {
    container.append(facesUI(store, which));
  } else {
    container.append(numbersUI(store, which));
  }
}

const band = (n) => (n === 0 ? 'none' : n <= 3 ? 'mild' : n <= 6 ? 'moderate' : 'severe');

function numbersUI(store, which) {
  const wrap = el('div', {});
  const grid = el('div', { class: 'scale' });
  for (let i = 0; i <= 10; i += 1) {
    grid.append(el('button', {
      type: 'button', class: `pt b-${band(i)} ${store[which] === i ? 'on' : ''}`, text: String(i),
      onclick: (e) => {
        store[which] = i;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
    }));
  }
  wrap.append(grid, el('div', { class: 'anchors' },
    el('span', { text: 'no pain' }), el('span', { text: 'worst pain' })));
  return wrap;
}

function facesUI(store, which) {
  const wrap = el('div', {});
  const grid = el('div', { class: 'faces' });
  for (let i = 0; i < 6; i += 1) {
    grid.append(el('button', {
      type: 'button', class: `face ${store[which] === i * 2 ? 'on' : ''}`,
      onclick: (e) => {
        store[which] = i * 2;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
      },
    }, faceSvg(i)));
  }
  wrap.append(grid, el('div', { class: 'anchors' },
    el('span', { text: 'no pain' }), el('span', { text: 'very much pain' })));
  return wrap;
}

function faceSvg(i) {
  const brow = [0, 2, 4, 7, 10, 13][i];
  const mouth = [8, 6, 3, 0, -4, -8][i];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  const add = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
    svg.append(n);
  };
  add('circle', { cx: 32, cy: 32, r: 28, class: 'f-line' });
  add('path', { d: `M18 ${26 - brow / 2} q5 ${-brow / 2} 10 0`, class: 'f-line' });
  add('path', { d: `M36 ${26 - brow / 2} q5 ${-brow / 2} 10 0`, class: 'f-line' });
  add('circle', { cx: 23, cy: 31, r: 2.6, class: 'f-dot' });
  add('circle', { cx: 41, cy: 31, r: 2.6, class: 'f-dot' });
  add('path', { d: `M20 ${44 - mouth / 3} q12 ${mouth} 24 0`, class: 'f-line' });
  return svg;
}

const FLACC = [
  ['face', 'Face', ['No particular expression', 'Occasional grimace or frown', 'Frequent frown, clenched jaw']],
  ['legs', 'Legs', ['Normal position, relaxed', 'Uneasy, restless, tense', 'Kicking, or legs drawn up']],
  ['activity', 'Activity', ['Lying quietly, moves easily', 'Squirming, shifting, tense', 'Arched, rigid, or jerking']],
  ['cry', 'Cry', ['No cry', 'Moans or whimpers', 'Crying steadily, screams']],
  ['consolability', 'Consolability', ['Content, relaxed', 'Reassured by touch or talk', 'Difficult to console']],
];

function flaccUI(store, which) {
  const key = which === 'rest' ? 'flacc_rest' : which === 'move' ? 'flacc_move' : `flacc_${which}`;
  const items = (store[key] ||= {});
  const wrap = el('div', {});
  const totalEl = el('div', { class: 'total' },
    el('span', { text: 'FLACC total' }), el('span', { text: '— / 10' }));

  const recalc = () => {
    try {
      store[which] = flaccTotal(items);
      totalEl.lastChild.textContent = `${store[which]} / 10`;
    } catch { store[which] = null; totalEl.lastChild.textContent = '— / 10'; }
  };

  FLACC.forEach(([k, label, options]) => {
    const row = el('div', { class: 'item-scale' });
    options.forEach((text, score) => {
      row.append(el('button', {
        type: 'button', class: items[k] === score ? 'on' : '',
        onclick: (e) => {
          items[k] = score;
          [...row.children].forEach((c) => c.classList.remove('on'));
          e.currentTarget.classList.add('on');
          recalc();
        },
      }, el('b', { text: String(score) }), el('span', { text })));
    });
    wrap.append(el('div', { class: 'item' }, el('p', { class: 'item-q', text: label }), row));
  });

  wrap.append(totalEl);
  recalc();
  return wrap;
}

/* ---------------- Module 5 ---------------- */

function buildModule5() {
  yesNo('reboundSpike', (v) => { F.m5.rebound_spike = v; });
  yesNo('burning', (v) => { F.m5.burning = v; });
  yesNo('immediateRescue', (v) => { F.m5.immediate_rescue = v; });

  $('sensationTime').addEventListener('input', () => { F.m5.sensation_return = $('sensationTime').value; });
  ['rescueDoses', 'toLiquids', 'toAmbulation', 'satisfaction']
    .forEach((id) => $(id).addEventListener('input', () => { F.m5[snake(id)] = num(id); }));
  $('ome').addEventListener('input', () => { F.m5.ome_mg = num('ome'); updateOmePerKg(); });
}

/** Weight-adjusted OME — the figure the study compares across children. */
function updateOmePerKg() {
  const { ome_mg: ome } = F.m5;
  const weight = F.m1.weight_kg;
  if (ome == null || !weight) { F.m5.ome_per_kg = null; $('omePerKg').textContent = '—'; return; }
  F.m5.ome_per_kg = Math.round((ome / weight) * 1000) / 1000;
  $('omePerKg').textContent = `${F.m5.ome_per_kg} mg/kg`;
}

/* ---------------- saving ---------------- */

/**
 * What this phone last sent for each module, so a second save supersedes it.
 *
 * Theatre saves the start times at induction and comes back for the end times
 * after closure; the ward types a timepoint it corrects an hour later. Rows
 * are append-only, so the correction is a new row — but it has to carry
 * `supersedes_uuid`, or the workbook holds two rows for one event with nothing
 * saying which one is true. Kept in localStorage rather than memory because
 * the hour between knife and closure is long enough for a phone to lock, a
 * tab to be dropped, and the page to reload.
 */
const savedKey = (studyNumber, mod, timepoint) => `${studyNumber}|${mod}|${timepoint || ''}`;

function lastSavedUuid(studyNumber, mod, timepoint) {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}')[savedKey(studyNumber, mod, timepoint)] || null;
  } catch { return null; }
}

function rememberSaved(studyNumber, mod, timepoint, uuid) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch { all = {}; }
  all[savedKey(studyNumber, mod, timepoint)] = uuid;
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
}


const SHEETS = {
  m1: '01_baseline', m2: '02_intraop', m3: '03_paed', m4: '04_ward_pain', m5: '05_recovery',
};

async function saveModule(mod) {
  const id = checkSubjectId(F.subjectId);
  if (!id.valid) {
    toast(centre ? 'Tap “New patient”, or type the number from the paper form' : 'Pick the centre first');
    $(centre ? 'subjectSeq' : 'centre').focus();
    scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  // The single hard block in the app, and it is clinical: a local anaesthetic
  // over the weight-adjusted ceiling is nearly always a decimal slip in the
  // form rather than a dose that was given. Everything else clinical warns.
  if (mod === 'm2' && F.m2.la_verdict === 'block') {
    toast('Local anaesthetic is over the maximum — check the % and the volume');
    $('laConc').focus();
    return;
  }
  if (mod === 'm2' && F.m2.domain && !F.m2.procedure_name) {
    toast('Name the operation, not just the domain');
    $('procedure').focus();
    return;
  }
  if (mod === 'm1' && !F.m1.hospital_number) {
    toast('Enter the hospital inpatient number first');
    $('hospitalNo').focus();
    return;
  }
  if (!who) {
    toast('Enter the evaluator name first');
    $('evaluator').focus();
    scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  const header = {
    subject_id: F.subjectId,
    centre: centre.code,
    centre_name: centre.name,
    consent: [...F.consent].join('; '),
    evaluator: who,
    eval_date: F.evalDate,
  };

  let data; let timepoint = null;
  if (mod === 'm1') data = { ...header, ...F.m1 };
  if (mod === 'm2') data = { ...header, ...F.m2 };
  if (mod === 'm3') {
    timepoint = F.paedTab;
    data = { ...header, paed_timepoint: F.paedTab, ...F.paed[F.paedTab] };
  }
  if (mod === 'm4') {
    timepoint = F.wardTab;
    const w = F.ward[F.wardTab] || {};
    data = {
      ...header, timepoint: F.wardTab,
      tool_used: routed ? routed.tool : null,
      age_months: F.m1.age_months ?? null,
      rest_pain: w.rest ?? null, dynamic_pain: w.move ?? null,
      rebound: w.rebound ?? null, rescue_given: w.rescue ?? null,
      flacc_rest: w.flacc_rest || null, flacc_dynamic: w.flacc_move || null,
    };
  }
  if (mod === 'm5') data = { ...header, ...F.m5 };

  const btn = document.querySelector(`[data-save="${mod}"]`);
  const supersedes = lastSavedUuid(F.subjectId, mod, timepoint);
  btn.disabled = true;
  const record = await sync.submit({
    form: SHEETS[mod], studyNumber: F.subjectId, timepoint, data, supersedes,
  });
  rememberSaved(F.subjectId, mod, timepoint, record.uuid);
  btn.disabled = false;
  markSaveButton(mod, timepoint);

  if (mod === 'm3') { (F.paed[F.paedTab] ||= {}).saved = true; refreshPaedTabs(); }
  if (mod === 'm4') { (F.ward[F.wardTab] ||= {}).saved = true; refreshWardTabs(); }
  if (['m1', 'm2', 'm5'].includes(mod)) {
    document.querySelector(`[data-module="${mod}"]`).classList.add('done');
  }
  // Remembered locally so the "already enrolled" warning survives a camp with
  // no signal, where the endpoint cannot be asked.
  if (mod === 'm1') { rememberEnrolled(F.subjectId); saySeen(F.subjectId, 'yes'); }

  const how = supersedes ? 'Updated' : 'Saved';
  toast(navigator.onLine ? how : `${how} on this phone — will send when there is signal`);
}

/**
 * A module already sent says so on its own button.
 *
 * Coming back to a half-filled module is the normal way theatre works, not an
 * error, so the button stops saying "Save" and starts saying "Update" — the
 * second tap is expected, and the row it writes supersedes the first.
 */
function markSaveButton(mod, timepoint = null) {
  const btn = document.querySelector(`[data-save="${mod}"]`);
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  const sent = F.subjectId && lastSavedUuid(F.subjectId, mod, timepoint);
  btn.textContent = sent ? btn.dataset.label.replace(/^Save/, 'Update') : btn.dataset.label;
}

/* ---------------- chrome ---------------- */

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function showPending(state) {
  if (state.rosterUpdated !== undefined) return;
  const badge = $('badge');
  const n = state.pending ?? 0;
  badge.textContent = n === 0 ? 'saved' : `${n} waiting`;
  badge.className = n === 0 ? 'badge' : 'badge waiting';
}

boot();
