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
import { flaccTotal, paedTotal, mypasSfScore, bmi, localAnaestheticDose } from './lib/scoring.js';
import { validate as checkSubjectId, format as formatSubjectId, parse as parseSubjectId } from './lib/studyNumber.js';
import * as sync from './lib/sync.js';

const APP_VERSION = '2026.09.22f-crf';
const WHO_KEY = 'ppp.who';
const CENTRE_KEY = 'ppp.centre';
const ENROLLED_KEY = 'ppp.enrolled';

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
  };
  $('weight').addEventListener('input', recalcBmi);
  $('height').addEventListener('input', recalcBmi);

  drawMypas();
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
  optionRow('domain', o.surgicalDomain, (v) => { F.m2.domain = v; });
  optionRow('approach', o.approach, (v) => { F.m2.approach = v; });
  optionRow('maintenance', o.maintenance, (v) => { F.m2.maintenance = v; });
  optionRow('guidance', o.guidance, (v) => { F.m2.guidance = v; });
  optionRow('laDrug', o.localAnaestheticDrugs, (v) => { F.m2.la_drug = v; updateLaDose(); });

  optionRow('block', o.block, (v) => {
    F.m2.block = v;
    $('blockDetail').hidden = (v === 'None');
    updateLaDose();
  });

  ['duration', 'incision', 'fentanyl', 'paracetamol', 'ketorolac', 'dexamethasone', 'ketamine']
    .forEach((id) => $(id).addEventListener('input', () => { F.m2[snake(id)] = num(id); }));

  ['laConc', 'laVol'].forEach((id) =>
    $(id).addEventListener('input', () => { F.m2[snake(id)] = num(id); updateLaDose(); }));
}

const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/**
 * The one number worth checking as it is typed. An entry over the ceiling is
 * far more often a decimal slip than a real overdose, and catching it before
 * the block is given is the whole point.
 */
function updateLaDose() {
  const note = $('laNote');
  const { la_drug: drug, la_conc: conc, la_vol: vol } = F.m2;
  const weight = F.m1.weight_kg;
  if (!drug || !conc || !vol || !weight) { note.textContent = ''; note.className = 'note'; F.m2.la_mg_per_kg = null; return; }
  try {
    const d = localAnaestheticDose({
      agent: drug.toLowerCase(), concentrationPct: conc, volumeMl: vol, weightKg: weight,
    });
    F.m2.la_mg_per_kg = d.mgPerKg;
    F.m2.la_pct_of_max = d.pctOfMax;
    note.textContent = d.verdict === 'block'
      ? `${d.mgPerKg} mg/kg — over the ${d.maxMgPerKg} mg/kg maximum. Check the volume and concentration.`
      : `${d.mgPerKg} mg/kg · ${d.pctOfMax}% of maximum`;
    note.className = `note ${d.verdict === 'block' ? 'bad' : d.verdict === 'warn' ? 'warn' : 'ok'}`;
  } catch {
    note.textContent = ''; note.className = 'note';
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
}

function refreshPaedTabs() {
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
  const verdict = $('paedVerdict');
  try {
    const total = paedTotal(store);
    store.total = total;
    out.textContent = `${total} / 20`;
    const cutoff = params().thresholds.paedEdCutoff;
    if (total >= cutoff && store.purposeful === 0) {
      verdict.textContent = 'Emergence delirium likely — calming and reassurance, not more opioid.';
      verdict.className = 'note warn';
    } else if (total >= cutoff) {
      verdict.textContent = `PAED ${total}. If movement is purposeful and the child makes eye contact, treat as pain.`;
      verdict.className = 'note warn';
    } else {
      verdict.textContent = 'Below the emergence-delirium cutoff. Distress here is more likely to be pain.';
      verdict.className = 'note ok';
    }
  } catch {
    store.total = null;
    out.textContent = '— / 20';
    verdict.textContent = '';
    verdict.className = 'note';
  }
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
  const key = which === 'rest' ? 'flacc_rest' : 'flacc_move';
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
  btn.disabled = true;
  await sync.submit({ form: SHEETS[mod], studyNumber: F.subjectId, timepoint, data });
  btn.disabled = false;

  if (mod === 'm3') { (F.paed[F.paedTab] ||= {}).saved = true; refreshPaedTabs(); }
  if (mod === 'm4') { (F.ward[F.wardTab] ||= {}).saved = true; refreshWardTabs(); }
  if (['m1', 'm2', 'm5'].includes(mod)) {
    document.querySelector(`[data-module="${mod}"]`).classList.add('done');
  }
  // Remembered locally so the "already enrolled" warning survives a camp with
  // no signal, where the endpoint cannot be asked.
  if (mod === 'm1') { rememberEnrolled(F.subjectId); saySeen(F.subjectId, 'yes'); }

  toast(navigator.onLine ? 'Saved' : 'Saved on this phone — will send when there is signal');
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
