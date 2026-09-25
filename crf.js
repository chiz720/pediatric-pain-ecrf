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
import { flaccTotal, paedTotal, mypasSfScore, bmi, localAnaestheticDose, doseMme, resolveMmeKey, pacuPathway, painBand, isModerateToSevere, reboundCriteria } from './lib/scoring.js';
import { minutesBetween, durationLabel, surgeryWithinAnaesthesia } from './lib/clock.js';
import { validate as checkSubjectId, format as formatSubjectId, parse as parseSubjectId } from './lib/studyNumber.js';
import * as sync from './lib/sync.js';

const APP_VERSION = '2026.09.25f-crf';
const WHO_KEY = 'ppp.who';
const CENTRE_KEY = 'ppp.centre';
const ENROLLED_KEY = 'ppp.enrolled';
const SAVED_KEY = 'ppp.saved';
const WARD_MEDS_KEY = 'ppp.wardmeds';
const WARD_RX_KEY = 'ppp.wardrx';
const RECENT_KEY = 'ppp.recent';
const RECENT_MAX = 20;

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

  // Both rebound questions state the same criteria, written from the same
  // parameters, so the screen cannot contradict what is being enforced.
  const criteria = `(${reboundCriteria('protocol')})`;
  $('reboundCriteriaWard').textContent = criteria;
  $('reboundCriteriaOffset').textContent = criteria;

  buildAdmin();
  showWho();              // the header line carries the centre too, and buildAdmin restores it
  buildModule1();
  buildModule2();
  buildModule3();
  buildModule4();
  buildModule5();
  buildRound();

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
  // Open on what is owed, not on the first tab. Opening a child at T2 who was
  // last scored at T12 costs a decision every visit and invites a save against
  // the wrong timepoint — and a ward round makes that decision thirty times.
  selectNextTimepoints(studyNumber);

  if (freshlyAllocated.has(studyNumber)) {
    note.textContent = `${studyNumber} — new number. Write it on the paper form before the child leaves.`;
    loadWardMeds(studyNumber);
    drawWardSummary();
    drawRecent();
    return;
  }
  note.textContent = studyNumber;
  loadWardMeds(studyNumber);
  drawWardSummary();
  drawRecent();
  confirmAgainstWorkbook(studyNumber);
}

/* ---------------- children this phone has seen ---------------- */

/**
 * The short list that replaces typing four digits five times per child.
 *
 * Ordered by when the child was last touched on this phone, because a ward
 * round works through the children in front of it and the one just seen is
 * rarely the one wanted next. Capped, so the list stays a list and not a
 * roster: it is a convenience for the phone holding it, never a claim about
 * who is enrolled in the study.
 */
function recentList() {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(all) ? all.filter((r) => r && r.sn) : [];
  } catch { return []; }
}

function rememberRecent(studyNumber) {
  if (!studyNumber) return;
  const list = recentList().filter((r) => r.sn !== studyNumber);
  list.unshift({ sn: studyNumber, ts: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  drawRecent();
  drawRound();
}

function drawRecent() {
  const wrap = $('recentWrap');
  const box = $('recent');
  if (!wrap || !box) return;
  const list = recentList();
  wrap.hidden = list.length === 0;
  box.replaceChildren();

  list.forEach(({ sn }) => {
    // The next thing owed to this child, worked out from what this phone has
    // saved, so the button says what it is for rather than only who it is.
    const due = firstUnsavedWardTimepoint(sn);
    const label = due ? `${sn.slice(-4)} · ${due.label}` : `${sn.slice(-4)} · done`;
    box.append(el('button', {
      type: 'button', class: sn === F.subjectId ? 'on' : '', text: label,
      onclick: () => openRecent(sn),
    }));
  });
}

/** Open a child the phone already knows, without retyping the serial. */
function openRecent(studyNumber) {
  const seq = studyNumber.slice(-4);
  $('subjectSeq').value = seq;
  readSerial();
  drawRecent();
  document.querySelector('[data-module="m4"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * The first ward timepoint this phone has not saved for a child.
 *
 * Opening on T2 for a child already scored at T2, T6 and T12 costs a decision
 * and invites a save against the wrong timepoint. Null once every timepoint has
 * been recorded — there is nothing further owed.
 */
function firstUnsavedWardTimepoint(studyNumber) {
  const tps = params().assessmentSchedule.timepoints;
  return tps.find((tp) => !lastSavedUuid(studyNumber, 'm4', tp.id)) || null;
}

/** The same idea for the three PACU timepoints. */
function firstUnsavedPaedTimepoint(studyNumber) {
  const tps = params().paedSchedule.timepoints;
  return tps.find((tp) => !lastSavedUuid(studyNumber, 'm3', tp.id)) || null;
}

/**
 * Point both tab strips at the next thing owed.
 *
 * Nothing is blocked by this: a nurse typing up T6 from paper at midnight can
 * still tap back to any timepoint, and a closed window never stops a late
 * record. It only changes which tab is in front of her when the child opens.
 */
function selectNextTimepoints(studyNumber) {
  const ward = firstUnsavedWardTimepoint(studyNumber);
  if (ward) F.wardTab = ward.id;
  const paed = firstUnsavedPaedTimepoint(studyNumber);
  if (paed) F.paedTab = paed.id;
  refreshWardTabs();
  refreshPaedTabs();
  drawWardScales();
  drawPaedItems();
}

/* ---------------- ward round ---------------- */

/**
 * One timepoint, every child on this phone.
 *
 * The round is the inverse of the rest of the form: a nurse walking a ward at
 * T6 works across children at one timepoint, while the form is built around one
 * child across timepoints. Going through the child-shaped door means returning
 * to the serial screen at every bed.
 *
 * It is a view over what this phone has saved and nothing more. Different
 * people fill different timepoints on different phones and the endpoint cannot
 * be read back, so a child scored by someone else still shows as due here. That
 * is a duplicate row, which the study resolves by supersedes and would rather
 * have than a gap.
 */
const round = { tp: null };

function buildRound() {
  $('roundStart').addEventListener('click', () => {
    $('roundBody').hidden = false;
    $('roundStart').hidden = true;
    drawRound();
  });

  $('roundExit').addEventListener('click', () => {
    round.tp = null;
    $('roundBody').hidden = true;
    $('roundStart').hidden = false;
    $('roundListWrap').hidden = true;
  });

  optionRow('roundTp',
    params().assessmentSchedule.timepoints.map((tp) => ({ label: tp.label, value: tp.id })),
    (id) => { round.tp = id; drawRound(); });
}

function drawRound() {
  const wrap = $('roundListWrap');
  const box = $('roundList');
  const note = $('roundNote');
  if (!wrap || !box) return;

  wrap.hidden = !round.tp;
  if (!round.tp) return;

  const tp = params().assessmentSchedule.timepoints.find((t) => t.id === round.tp);
  const children = recentList();
  box.replaceChildren();

  let due = 0;
  children.forEach(({ sn }) => {
    const done = Boolean(lastSavedUuid(sn, 'm4', round.tp));
    if (!done) due += 1;
    box.append(el('button', {
      type: 'button',
      class: `${done ? 'done' : ''}${sn === F.subjectId ? ' on' : ''}`.trim(),
      text: `${sn.slice(-4)}${done ? ' ✓' : ''}`,
      onclick: () => openRoundChild(sn),
    }));
  });

  if (!children.length) {
    note.className = 'note';
    note.textContent = 'No children on this phone yet. Enrol one below, or open one by its number once.';
    return;
  }
  note.className = due ? 'note warn' : 'note ok';
  note.textContent = due
    ? `${children.length} ${children.length === 1 ? 'child' : 'children'} on this phone · ${due} still due at ${tp.label}.`
    : `Every child on this phone has ${tp.label} recorded.`;
}

/**
 * Open a child straight onto the round's timepoint.
 *
 * readSerial() normally points the tabs at the first timepoint a child has not
 * had, which is right when opening one child and wrong in the middle of a
 * round: the round is at T6 and stays at T6 even for a child whose T2 was
 * missed. Set after, so the round wins.
 */
function openRoundChild(studyNumber) {
  $('subjectSeq').value = studyNumber.slice(-4);
  readSerial();
  if (round.tp) {
    F.wardTab = round.tp;
    refreshWardTabs();
    drawWardScales();
  }
  drawRound();
  document.querySelector('[data-module="m4"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** After a ward save during a round, go back to the list with the next child. */
function returnToRound() {
  if (!round.tp) return;
  drawRound();
  $('roundCard')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    drawWardMeds();        // and on the ward
    drawWardRx();          // and what the ward prescribed per kilogram
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
  const weight = F.m1.weight_kg;
  list.replaceChildren();
  opioidLog.forEach((d, i) => {
    // Every drug this form records shows what it came to per kilogram. An
    // intraoperative opioid is the one most often checked against a reference
    // range at the bedside — fentanyl in mcg/kg, morphine in mg/kg — so the
    // figure belongs beside the dose rather than only inside the total.
    const perKg = weight ? `${Math.round((d.amount / weight) * 1000) / 1000} ${d.unit}/kg` : 'needs weight';
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.amount} ${d.unit}` }),
      el('span', { class: 'muted', text: perKg }),
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
  const weightNow = F.m1.weight_kg;
  agents.forEach((a) => {
    delete F.m2[`opioid_${a.name.toLowerCase()}_${a.unit}`];
    delete F.m2[`opioid_${a.name.toLowerCase()}_per_kg`];
  });
  for (const [drug, amount] of perDrug) {
    const agent = agents.find((a) => a.name === drug);
    F.m2[`opioid_${drug.toLowerCase()}_${agent.unit}`] = Math.round(amount * 1000) / 1000;
    // The morphine equivalent per kilogram is the study endpoint, but it hides
    // which drug delivered it. The per-agent figure is what makes a dosing
    // outlier attributable to the agent that caused it.
    if (weightNow) {
      F.m2[`opioid_${drug.toLowerCase()}_per_kg`] = Math.round((amount / weightNow) * 1000) / 1000;
    }
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

/**
 * A score that does not ask for anything is a score nobody acts on.
 *
 * The band is stored rather than left to be re-derived later, and at or above
 * the moderate-to-severe threshold the form says so and points at the rescue
 * section. Below it, it says no rescue is indicated — which is the half that
 * matters for the dataset, because it makes an empty rescue log read as a
 * decision rather than as a gap. Neither message blocks anything.
 */
function updatePacuPain() {
  const store = (F.paed[F.paedTab] ||= {});
  const note = $('pacuPainNote');
  const score = store.pacu_pain;

  store.pacu_pain_band = null;
  store.pacu_rescue_indicated = null;

  if (score == null) {
    note.className = 'note';
    note.textContent = 'Score the child before deciding anything — this is the number the rescue decision rests on.';
    drawRescue();
    return;
  }

  const band = painBand(score);
  const indicated = isModerateToSevere(score);
  store.pacu_pain_band = band;
  store.pacu_rescue_indicated = indicated;

  // On the delirium pathway the rescue list is out of sight, so the wording
  // must not tell the rater to fill in a list that is not there. A child can be
  // delirious and sore at the same time; both get recorded, and what to do
  // about it is a clinical judgement the form does not make.
  const onDelirium = store.pacu_pathway === 'delirium';

  if (indicated && onDelirium) {
    note.className = 'note warn';
    note.textContent = `${score}/10 — ${band} pain recorded alongside a delirium picture. Both are now on the record. Opioid escalation is not the answer to delirium, but this score says the child may also be in pain — treat on your judgement and record anything given under the delirium section.`;
  } else if (indicated) {
    note.className = 'note warn';
    note.textContent = `${score}/10 — ${band} pain. At or above ${params().thresholds.moderateToSevere} rescue analgesia is indicated: record what was given below.`;
  } else if (onDelirium) {
    note.className = 'note ok';
    note.textContent = `${score}/10 — ${band} pain. Below the treatment threshold, which is what separates this from pain-driven distress.`;
  } else {
    note.className = 'note ok';
    note.textContent = `${score}/10 — ${band} pain. Below the treatment threshold; no rescue indicated. Leaving the list empty records that decision.`;
  }
  drawRescue();
}

/** The timepoint after this one, for the reassessment prompt. */
function nextPaedTimepoint() {
  const tps = params().paedSchedule.timepoints;
  const i = tps.findIndex((t) => t.id === F.paedTab);
  return i >= 0 && i < tps.length - 1 ? tps[i + 1] : null;
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

  const next = nextPaedTimepoint();
  store.rescue_reassess_at = log.length && next ? next.id : null;

  const note = $('rescueNote');
  if (unconverted.size) {
    note.className = 'note warn';
    note.textContent = `${[...unconverted].join(' and ')} has no published IV conversion, so it is recorded but left out of the morphine equivalent.`;
  } else if (anyOpioid && !weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to express this per kilogram.';
  } else if (log.length && next) {
    // Rescue given means the question is now whether it worked.
    note.className = 'note ok';
    note.textContent = `Given at this timepoint. Score again at ${next.label} to see whether it worked.`;
  } else if (!log.length && store.pacu_rescue_indicated === true) {
    note.className = 'note warn';
    note.textContent = 'Rescue is indicated by the score and nothing is recorded yet.';
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
    $('pacuPainScore').hidden = true;
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

  // The score is asked on every pathway; only the treatment that follows it
  // branches. Opioid rescue stays out of sight for delirium because there the
  // wrong answer is more opioid — but the child still has a pain score, and it
  // is still an outcome.
  $('pacuPainScore').hidden = false;
  $('painPath').hidden = pathway !== 'pain';
  $('deliriumPath').hidden = pathway !== 'delirium';

  const tool = toolName(routed ? routed.tool : null) || 'enter the age in Module 1';
  $('pacuScaleLabel').textContent = pathway === 'delirium'
    ? `Pain score — ${tool} · score it even though this looks like delirium`
    : `Pain score — ${tool}`;
  paintScale($('pacuScale'), store, 'pacu_pain', updatePacuPain);
  updatePacuPain();

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
  yesNo('rescue', (v) => {
    (F.ward[F.wardTab] ||= {}).analgesia_any = v;
    $('wardMeds').hidden = !v;
    drawWardMeds();
  });
  buildWardMeds();
  buildWardRx();
  drawWardScales();
}

/* ---------------- ward analgesia ---------------- */

/**
 * What was given on the ward, and whether it was prescribed or for
 * breakthrough pain.
 *
 * That distinction is the point of the section rather than a nicety:
 * breakthroughPain counts PRN rescue, so a six-hourly paracetamol that happens
 * to fall at T6 must not be counted as a breakthrough event. One tap of "No"
 * is still the whole answer when nothing was given — the drug list only opens
 * when there is something to record, because this is asked five times per
 * child over 48 hours.
 *
 * Route is asked for every drug, and the route names match the map in
 * lib/scoring.js exactly, because morphine by mouth is a third of the morphine
 * equivalent of morphine by vein. Anything the map cannot convert is recorded,
 * totalled, and named as excluded rather than quietly counted as zero.
 */
let wardMedLog = {};
const wardMeds = (tp) => (wardMedLog[tp] ||= []);

/**
 * The ward log survives a reload, because a ward stay outlives a browser tab.
 *
 * Forty-eight hours means the phone will be locked, the tab dropped and the
 * page reloaded several times between T2 and T48. Kept per study number, so
 * picking up a different child does not inherit the last one's drugs.
 *
 * It is what THIS phone recorded and nothing more. Different people fill
 * different timepoints on different phones, and the endpoint deliberately
 * cannot be read back, so the summary says so on its face rather than
 * pretending to be the child's complete ward record.
 */
function loadWardMeds(studyNumber) {
  try {
    const all = JSON.parse(localStorage.getItem(WARD_MEDS_KEY) || '{}');
    wardMedLog = all[studyNumber] || {};
  } catch { wardMedLog = {}; }
  loadWardRx(studyNumber);
}

function saveWardMeds() {
  if (!F.subjectId) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(WARD_MEDS_KEY) || '{}'); } catch { all = {}; }
  all[F.subjectId] = wardMedLog;
  localStorage.setItem(WARD_MEDS_KEY, JSON.stringify(all));
}

/* ---------------- ward prescription ---------------- */

/**
 * The regular analgesia on the drug chart.
 *
 * Belongs to the child, not to a timepoint: the nurse at T24 should read what
 * was prescribed at admission rather than type it again. Kept per study number
 * on the phone for the same reason the ward med log is, and written onto every
 * ward row so a prescription changed during the stay reads as a change instead
 * of silently rewriting what was true at T2.
 */
let wardRxLog = [];
let wardRxNone = null;
let wardRxEditing = false;

function loadWardRx(studyNumber) {
  try {
    const all = JSON.parse(localStorage.getItem(WARD_RX_KEY) || '{}');
    const saved = all[studyNumber] || {};
    wardRxLog = saved.log || [];
    wardRxNone = saved.none ?? null;
  } catch { wardRxLog = []; wardRxNone = null; }
  wardRxEditing = false;
  drawWardRx();
}

function saveWardRx() {
  if (!F.subjectId) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(WARD_RX_KEY) || '{}'); } catch { all = {}; }
  all[F.subjectId] = { log: wardRxLog, none: wardRxNone };
  localStorage.setItem(WARD_RX_KEY, JSON.stringify(all));
}

function buildWardRx() {
  const { routes, prescription } = params().wardAnalgesia;
  const opioids = params().opioids.intraoperative.agents;
  const nonOpioids = params().nonOpioids.agents;
  const agents = [
    ...nonOpioids.map((a) => ({ ...a, opioid: false })),
    ...opioids.map((a) => ({ ...a, opioid: true })),
  ];
  let picked = null;
  let route = null;
  let interval = null;

  drawWardRxNone();

  $('wardRxEdit').addEventListener('click', () => {
    wardRxEditing = true;
    drawWardRx();
  });

  optionRow('wardRxDrug', agents.map((a) => ({ label: a.name, value: a.name })), (name) => {
    picked = agents.find((a) => a.name === name) || null;
    route = null;
    interval = null;
    $('wardRxUnit').textContent = picked ? `(${picked.unit})` : '';
    $('wardRxRouteField').hidden = !picked;
    $('wardRxDoseField').hidden = true;
    optionRow('wardRxRoute', routes, (r) => {
      route = r;
      $('wardRxDose').value = '';
      $('wardRxDoseField').hidden = false;
    });
  });

  optionRow('wardRxInterval',
    prescription.intervalsHours.map((h) => ({ label: h === 24 ? 'Once daily' : `${h}-hourly`, value: h })),
    (h) => { interval = Number(h); });

  $('addWardRx').addEventListener('click', () => {
    const amount = num('wardRxDose');
    if (!picked) { toast('Pick the drug first'); return; }
    if (!route) { toast('Which route?'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the prescribed dose'); return; }
    if (interval == null) { toast('How often is it prescribed?'); return; }
    wardRxLog.push({
      drug: picked.name, route, amount, unit: picked.unit,
      intervalH: interval, opioid: picked.opioid,
    });
    $('wardRxDose').value = '';
    wardRxNone = 0;
    wardRxEditing = true;
    saveWardRx();
    drawWardRx();
  });
}

const intervalLabel = (h) => (h === 24 ? 'once daily' : `${h}-hourly`);

/**
 * "None prescribed" is a finding, not an empty field.
 *
 * A child on no regular analgesia is exactly the case the breakthrough endpoint
 * needs to identify, and a blank cannot be told apart from a form nobody got to.
 * Redrawn rather than wired once, so a prescription read back off this phone at
 * T24 shows the answer that was given at T2 already selected.
 */
function drawWardRxNone() {
  const { noneLabel } = params().wardAnalgesia.prescription;
  optionRow('wardRxNone', [
    { label: 'Something is prescribed', value: 0 },
    { label: noneLabel, value: 1 },
  ], (v) => {
    wardRxNone = v;
    // Touching the block means she is working in it — it stays open until a
    // different child is opened, so adding a second drug needs no extra tap.
    wardRxEditing = true;
    saveWardRx();
    drawWardRx();
  }, wardRxNone);
}

function drawWardRx() {
  const list = $('wardRxList');
  if (!list) return;
  const weight = F.m1.weight_kg;
  list.replaceChildren();

  wardRxLog.forEach((d, i) => {
    const perKg = weight
      ? `${Math.round((d.amount / weight) * 1000) / 1000} ${d.unit}/kg`
      : 'needs weight';
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.route} ${d.amount} ${d.unit} ${intervalLabel(d.intervalH)}` }),
      el('span', { class: 'muted', text: perKg }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { wardRxLog.splice(i, 1); saveWardRx(); drawWardRx(); },
      })));
  });

  if ($('wardRxPicker')) $('wardRxPicker').hidden = wardRxNone === 1;
  drawWardRxNone();
  collapseWardRx();

  const note = $('wardRxNote');
  if (wardRxNone === 1) {
    note.className = 'note warn';
    note.textContent = 'No regular analgesia prescribed. Recorded as a finding — every dose on the ward will count as breakthrough.';
  } else if (!wardRxLog.length) {
    note.className = 'note';
    note.textContent = 'What is written up regularly on the chart, with how often. Entered once; it carries to every later timepoint.';
  } else if (!weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to get these per kilogram.';
  } else {
    note.className = 'note ok';
    note.textContent = `${wardRxLog.length} regular ${wardRxLog.length === 1 ? 'drug' : 'drugs'} prescribed.`;
  }
}

/**
 * Once it is answered, the prescription folds to a line.
 *
 * It is a per-child fact sitting on a per-timepoint screen, so after the first
 * visit it is in the way of the thing the nurse actually came to do. Reopened
 * by tapping "change", which is also what she needs when the chart is rewritten
 * mid-stay — and because the answer is written onto every ward row, that
 * rewrite reads as a change at the timepoint it happened.
 */
function collapseWardRx() {
  const summary = $('wardRxSummary');
  const full = $('wardRxFull');
  if (!summary || !full) return;

  const answered = wardRxNone === 1 || wardRxLog.length > 0;
  const show = answered && !wardRxEditing;

  summary.hidden = !show;
  full.hidden = show;

  if (show) {
    $('wardRxSummaryText').textContent = wardRxNone === 1
      ? params().wardAnalgesia.prescription.noneLabel
      : wardRxLog.map((d) => `${d.drug} ${d.amount} ${d.unit} ${intervalLabel(d.intervalH)}`).join(' · ');
  }
}

/** The prescription, flattened onto whichever ward row is being saved. */
function wardRxColumns() {
  const weight = F.m1.weight_kg;
  const out = {
    rx_none: wardRxNone == null ? null : wardRxNone,
    rx_drug_count: wardRxNone === 1 ? 0 : wardRxLog.length,
    rx_regimen: wardRxLog.length
      ? wardRxLog.map((d) => `${d.drug} ${d.route} ${d.amount} ${d.unit} ${intervalLabel(d.intervalH)}`).join('; ')
      : null,
  };
  for (const d of wardRxLog) {
    const key = `${d.drug.toLowerCase()}_${d.route.toLowerCase()}`;
    out[`rx_${key}_${d.unit}`] = d.amount;
    out[`rx_${key}_interval_h`] = d.intervalH;
    if (weight) out[`rx_${key}_per_kg`] = Math.round((d.amount / weight) * 1000) / 1000;
  }
  return out;
}

function buildWardMeds() {
  const { types, routes } = params().wardAnalgesia;
  const opioids = params().opioids.intraoperative.agents;
  const nonOpioids = params().nonOpioids.agents;
  let type = null;
  let opioid = null;
  let opioidRoute = null;
  let nonOpioid = null;
  let nonOpioidRoute = null;

  optionRow('wardType', types, (v) => { type = v; });

  optionRow('wardOpioid', opioids.map((a) => ({ label: a.name, value: a.name })), (name) => {
    opioid = opioids.find((a) => a.name === name) || null;
    opioidRoute = null;
    $('wardOpioidUnit').textContent = opioid ? `(${opioid.unit})` : '';
    $('wardOpioidRouteField').hidden = !opioid;
    $('wardOpioidDoseField').hidden = true;
    optionRow('wardOpioidRoute', routes, (r) => {
      opioidRoute = r;
      $('wardOpioidDose').value = '';
      $('wardOpioidDoseField').hidden = false;
    });
  });
  $('addWardOpioid').addEventListener('click', () => {
    const amount = num('wardOpioidDose');
    if (!type) { toast('Prescribed, or for breakthrough?'); return; }
    if (!opioid) { toast('Pick the opioid first'); return; }
    if (!opioidRoute) { toast('Which route?'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    wardMeds(F.wardTab).push({ type, drug: opioid.name, route: opioidRoute, amount, unit: opioid.unit, opioid: true });
    $('wardOpioidDose').value = '';
    drawWardMeds();
  });

  optionRow('wardNonOpioid', nonOpioids.map((a) => ({ label: a.name, value: a.name })), (name) => {
    nonOpioid = name;
    nonOpioidRoute = null;
    $('wardNonOpioidRouteField').hidden = false;
    $('wardNonOpioidDoseField').hidden = true;
    optionRow('wardNonOpioidRoute', routes, (r) => {
      nonOpioidRoute = r;
      $('wardNonOpioidDose').value = '';
      $('wardNonOpioidDoseField').hidden = false;
    });
  });
  $('addWardNonOpioid').addEventListener('click', () => {
    const amount = num('wardNonOpioidDose');
    if (!type) { toast('Prescribed, or for breakthrough?'); return; }
    if (!nonOpioid) { toast('Pick the drug first'); return; }
    if (!nonOpioidRoute) { toast('Which route?'); return; }
    if (amount == null || !(amount > 0)) { toast('Type the dose that was given'); return; }
    wardMeds(F.wardTab).push({ type, drug: nonOpioid, route: nonOpioidRoute, amount, unit: 'mg', opioid: false });
    $('wardNonOpioidDose').value = '';
    drawWardMeds();
  });
}

/**
 * Everything given across the stay, so far, at a glance.
 *
 * A nurse at T24 should not have to scroll back through four timepoints to see
 * what is on the prescription and what the child has already had for
 * breakthrough pain — that is how a sixth dose of paracetamol gets given.
 */
function drawWardSummary() {
  const panel = $('wardSoFar');
  const body = $('wardSoFarBody');
  const weight = F.m1.weight_kg;
  const all = Object.entries(wardMedLog).flatMap(([tp, log]) => log.map((d) => ({ ...d, tp })));

  if (!all.length) { panel.hidden = true; return; }
  panel.hidden = false;
  body.replaceChildren();

  const roll = (rows) => {
    const by = new Map();
    for (const d of rows) {
      const key = `${d.drug} ${d.route}`;
      const cur = by.get(key) || { amount: 0, n: 0, unit: d.unit };
      by.set(key, { amount: cur.amount + d.amount, n: cur.n + 1, unit: d.unit });
    }
    return [...by].map(([key, v]) =>
      `${key} ${Math.round(v.amount * 1000) / 1000} ${v.unit}${v.n > 1 ? ` (${v.n} doses)` : ''}`);
  };

  const row = (label, text, mono) => {
    body.append(el('dt', { text: label }), el('dd', { class: mono ? 'mono' : null, text }));
  };

  const scheduled = roll(all.filter((d) => d.type === 'Scheduled'));
  const prn = roll(all.filter((d) => d.type !== 'Scheduled'));
  row('Scheduled', scheduled.length ? scheduled.join(' · ') : 'none recorded', true);
  row('Breakthrough', prn.length ? prn.join(' · ') : 'none', true);

  let mme = 0;
  let prnMme = 0;
  for (const d of all) {
    if (!d.opioid || !resolveMmeKey(d.drug, d.route)) continue;
    const m = doseMme({ drug: d.drug, route: d.route, amount: d.amount, unit: d.unit });
    mme += m;
    if (d.type !== 'Scheduled') prnMme += m;
  }
  if (mme > 0) {
    const total = Math.round(mme * 1000) / 1000;
    const perKg = weight ? `${Math.round((mme / weight) * 1000) / 1000} mg/kg` : '— mg/kg (needs weight)';
    row('Opioid load', `${perKg} · ${total} mg total · ${Math.round(prnMme * 1000) / 1000} mg as PRN`, true);
  }

  const tps = params().assessmentSchedule.timepoints;
  row('Timepoints', tps.map((t) => `${t.id}${(wardMedLog[t.id] || []).length ? ' ✓' : ' —'}`).join('  '), true);
}

function drawWardMeds() {
  const store = (F.ward[F.wardTab] ||= {});
  const log = wardMeds(F.wardTab);
  const weight = F.m1.weight_kg;
  const list = $('wardMedList');
  list.replaceChildren();

  let mme = 0;
  let prnMme = 0;
  const unconverted = new Set();

  log.forEach((d, i) => {
    let per = weight ? `${Math.round((d.amount / weight) * 1000) / 1000} ${d.unit}/kg` : 'needs weight';
    if (d.opioid) {
      if (resolveMmeKey(d.drug, d.route)) {
        const m = doseMme({ drug: d.drug, route: d.route, amount: d.amount, unit: d.unit });
        mme += m;
        if (d.type !== 'Scheduled') prnMme += m;
      } else {
        unconverted.add(`${d.drug} ${d.route}`);
        per += ' · not converted';
      }
    }
    list.append(el('li', {},
      el('span', { text: `${d.drug} ${d.route} ${d.amount} ${d.unit}` }),
      el('span', { class: 'muted', text: `${d.type === 'Scheduled' ? 'scheduled' : 'PRN'} · ${per}` }),
      el('button', {
        type: 'button', class: 'linkish', text: 'remove',
        onclick: () => { log.splice(i, 1); drawWardMeds(); },
      })));
  });

  const prn = log.filter((d) => d.type !== 'Scheduled');
  const anyOpioid = log.some((d) => d.opioid);

  store.meds_given = log.length
    ? log.map((d) => `${d.type === 'Scheduled' ? 'S' : 'PRN'} ${d.drug} ${d.route} ${d.amount} ${d.unit}`).join('; ')
    : null;
  store.meds_dose_count = log.length;
  store.scheduled_doses = log.filter((d) => d.type === 'Scheduled').length;
  store.prn_doses = prn.length;
  // The breakthrough endpoint counts PRN rescue, so this is the flag it needs.
  store.rescue_given = prn.length > 0;
  store.mme_mg = anyOpioid ? Math.round(mme * 1000) / 1000 : null;
  store.prn_mme_mg = anyOpioid ? Math.round(prnMme * 1000) / 1000 : null;
  store.mme_per_kg = (store.mme_mg != null && weight)
    ? Math.round((store.mme_mg / weight) * 1000) / 1000 : null;
  store.mme_excluded = unconverted.size ? [...unconverted].join('; ') : null;

  const value = $('wardMme').lastChild;
  value.replaceChildren();
  if (!anyOpioid) {
    value.append('—');
  } else if (store.mme_per_kg != null) {
    value.append(`${store.mme_per_kg} mg/kg`,
      el('span', { class: 'sub', text: `${store.mme_mg} mg total · ${store.prn_mme_mg} mg as PRN` }));
  } else {
    value.append('— mg/kg', el('span', { class: 'sub', text: `${store.mme_mg} mg total` }));
  }

  saveWardMeds();
  drawWardSummary();

  const note = $('wardMedNote');
  if (unconverted.size) {
    note.className = 'note warn';
    note.textContent = `${[...unconverted].join(' and ')} has no published conversion for that route, so it is recorded but left out of the morphine equivalent.`;
  } else if (anyOpioid && !weight) {
    note.className = 'note warn';
    note.textContent = 'Enter the weight in Module 1 to express this per kilogram.';
  } else if (!log.length) {
    note.className = 'note';
    note.textContent = 'Each dose, and whether it was on the prescription or given for breakthrough pain.';
  } else {
    note.className = 'note ok';
    note.textContent = `${store.scheduled_doses} scheduled, ${store.prn_doses} for breakthrough.`;
  }
}

function refreshWardTabs() {
  markSaveButton('m4', F.wardTab);
  const store = F.ward[F.wardTab] || {};
  $('wardMeds').hidden = store.analgesia_any !== true;
  drawWardMeds();
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

function paintScale(container, store, which, onChange) {
  container.replaceChildren();
  if (!routed) {
    container.append(el('p', { class: 'note', text: 'Enter age in Module 1 first.' }));
    return;
  }
  if (routed.tool === TOOLS.FLACC || routed.tool === TOOLS.R_FLACC) {
    container.append(flaccUI(store, which, onChange));
  } else if (routed.tool === TOOLS.FPS_R) {
    container.append(facesUI(store, which, onChange));
  } else {
    container.append(numbersUI(store, which, onChange));
  }
}

const band = (n) => (n === 0 ? 'none' : n <= 3 ? 'mild' : n <= 6 ? 'moderate' : 'severe');

function numbersUI(store, which, onChange) {
  const wrap = el('div', {});
  const grid = el('div', { class: 'scale' });
  for (let i = 0; i <= 10; i += 1) {
    grid.append(el('button', {
      type: 'button', class: `pt b-${band(i)} ${store[which] === i ? 'on' : ''}`, text: String(i),
      onclick: (e) => {
        store[which] = i;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        if (onChange) onChange();
      },
    }));
  }
  wrap.append(grid, el('div', { class: 'anchors' },
    el('span', { text: 'no pain' }), el('span', { text: 'worst pain' })));
  return wrap;
}

function facesUI(store, which, onChange) {
  const wrap = el('div', {});
  const grid = el('div', { class: 'faces' });
  for (let i = 0; i < 6; i += 1) {
    grid.append(el('button', {
      type: 'button', class: `face ${store[which] === i * 2 ? 'on' : ''}`,
      onclick: (e) => {
        store[which] = i * 2;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        if (onChange) onChange();
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

function flaccUI(store, which, onChange) {
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
    if (onChange) onChange();
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
      rebound: w.rebound ?? null,
      flacc_rest: w.flacc_rest || null, flacc_dynamic: w.flacc_move || null,
      analgesia_any: w.analgesia_any ?? null,
      meds_given: w.meds_given ?? null,
      meds_dose_count: w.meds_dose_count ?? null,
      scheduled_doses: w.scheduled_doses ?? null,
      prn_doses: w.prn_doses ?? null,
      rescue_given: w.rescue_given ?? null,
      mme_mg: w.mme_mg ?? null,
      prn_mme_mg: w.prn_mme_mg ?? null,
      mme_per_kg: w.mme_per_kg ?? null,
      mme_excluded: w.mme_excluded ?? null,
      // The prescription rides on every ward row. It is the same answer each
      // time unless the chart changed, and if it did, the change is visible
      // against the timepoint it happened at rather than overwriting history.
      ...wardRxColumns(),
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
  rememberRecent(F.subjectId);
  btn.disabled = false;
  markSaveButton(mod, timepoint);

  if (mod === 'm3') { (F.paed[F.paedTab] ||= {}).saved = true; refreshPaedTabs(); }
  if (mod === 'm4') {
    (F.ward[F.wardTab] ||= {}).saved = true;
    refreshWardTabs();
    // Mid-round, the next thing wanted is the next child, not this one again.
    returnToRound();
  }
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
