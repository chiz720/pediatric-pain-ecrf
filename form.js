/**
 * The pain assessment form.
 *
 * Six questions. Everything else is done for the nurse: the scale is picked
 * from the child's age, FLACC is totalled, the record waits on the phone when
 * there is no signal. If a rule here ever makes someone stop and think, it
 * belongs somewhere else.
 */

import { CONFIG } from './config.js';
import { loadParams, params } from './lib/params.js';
import { selectInstrument, TOOLS } from './lib/routing.js';
import { ageLabel } from './lib/age.js';
import { flaccTotal } from './lib/scoring.js';
import { validate as checkStudyNumber } from './lib/studyNumber.js';
import * as sync from './lib/sync.js';

const APP_VERSION = '2026.09.11-simple';
const WHO_KEY = 'ppp.who';

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

const answers = {
  study: '', dob: {}, timepoint: '', rest: null, move: null, rescue: null,
  flaccRest: {}, flaccMove: {},
};
let who = null;
let routed = null;

/* ------------------------------------------------------------------ */

async function boot() {
  const paramsJson = await fetch('./schema/params.json').then((r) => r.json());
  loadParams(paramsJson);

  who = localStorage.getItem(WHO_KEY);
  if (!who) who = await askWho();
  $('who').textContent = who;

  sync.configure({
    endpointUrl: CONFIG.endpointUrl,
    token: CONFIG.campKey,
    deviceId: deviceId(),
    raterId: who,
    training: false,
    schemaVersion: '1.0.0',
    paramsVersion: paramsJson.paramsVersion,
    appVersion: APP_VERSION,
  });
  sync.onChange(showPending);
  sync.startAutoSync();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  buildMonths();
  buildTimepoints();
  buildRescue();
  wire();
}

function deviceId() {
  let id = localStorage.getItem('ppp.device.id');
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('ppp.device.id', id);
  }
  return id;
}

/** Asked once, ever. */
function askWho() {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'done' },
      el('div', {},
        el('h2', { text: 'Who are you?' }),
        el('p', { text: 'Tap your name. You will not be asked again.' }),
        el('div', { class: 'choices', style: 'flex-direction:column' },
          ...CONFIG.collectors.map((name) => el('button', {
            class: 'choice', text: name,
            onclick: () => {
              localStorage.setItem(WHO_KEY, name);
              overlay.remove();
              resolve(name);
            },
          }))),
      ));
    document.body.append(overlay);
  });
}

/* ---------------- question 1: study number ---------------- */

function wire() {
  const study = $('study');
  study.addEventListener('input', () => {
    study.value = study.value.toUpperCase();
    answers.study = study.value.trim();
    const note = $('studyNote');
    if (!answers.study) {
      study.className = 'mono'; note.textContent = ''; note.className = 'note';
    } else {
      const r = checkStudyNumber(answers.study);
      study.className = `mono ${r.valid ? 'ok' : 'bad'}`;
      note.textContent = r.valid ? '✓ looks right' : 'Check the number — the last character does not match.';
      note.className = `note ${r.valid ? 'ok' : 'bad'}`;
    }
    refresh();
  });

  ['dd', 'mm', 'yy'].forEach((id) => $(id).addEventListener('input', readDob));
  $('mm').addEventListener('change', readDob);

  $('submit').addEventListener('click', save);
  $('next').addEventListener('click', () => resetForm(true));
  $('sameChild').addEventListener('click', () => resetForm(false));
}

function buildMonths() {
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  names.forEach((n, i) => $('mm').append(el('option', { value: i + 1, text: n })));
}

/* ---------------- question 2: age decides the scale ---------------- */

function readDob() {
  answers.dob = { day: +$('dd').value || 0, month: +$('mm').value || 0, year: +$('yy').value || 0 };
  const { day, month, year } = answers.dob;
  const note = $('ageNote');
  routed = null;

  if (!day || !month || !year || String(year).length !== 4) {
    note.hidden = true;
    hideScales();
    refresh();
    return;
  }

  try {
    const now = new Date().toISOString();
    routed = selectInstrument({ dateOfBirth: answers.dob, assessedAt: now });
    note.hidden = false;
    note.textContent = `${ageLabel(answers.dob, now)} — ${scaleName(routed.tool)}`;
    drawScales();
  } catch {
    note.hidden = false;
    note.textContent = 'That date does not look right — check the year.';
    hideScales();
  }
  refresh();
}

const scaleName = (tool) => ({
  [TOOLS.FLACC]: 'watch the child (FLACC)',
  [TOOLS.R_FLACC]: 'watch the child (FLACC)',
  [TOOLS.FPS_R]: 'ask the child to point at a face',
  [TOOLS.NRS]: 'ask the child for a number 0–10',
}[tool] || '');

/* ---------------- question 3: timepoint ---------------- */

function buildTimepoints() {
  const box = $('timepoints');
  const tps = params().assessmentSchedule.timepoints;
  [...tps.map((t) => ({ id: t.id, label: t.label.replace('T+', '') })),
    { id: 'UNSCHED', label: 'Extra check' }]
    .forEach((t) => {
      box.append(el('button', {
        class: 'choice', text: t.label,
        onclick: (e) => {
          answers.timepoint = t.id;
          [...box.children].forEach((c) => c.classList.remove('on'));
          e.currentTarget.classList.add('on');
          refresh();
        },
      }));
    });
}

function buildRescue() {
  const box = $('rescue');
  [['No', false], ['Yes', true]].forEach(([label, v]) => {
    box.append(el('button', {
      class: 'choice', text: label,
      onclick: (e) => {
        answers.rescue = v;
        [...box.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        refresh();
      },
    }));
  });
}

/* ---------------- questions 4 and 5: the pain scales ---------------- */

function hideScales() {
  ['restBlock', 'moveBlock', 'rescueBlock'].forEach((id) => { $(id).hidden = true; });
}

function drawScales() {
  $('restBlock').hidden = false;
  $('moveBlock').hidden = false;
  $('rescueBlock').hidden = false;
  drawScale($('restScale'), 'rest');
  drawScale($('moveScale'), 'move');
}

function drawScale(container, which) {
  container.replaceChildren();
  if (routed.tool === TOOLS.FLACC || routed.tool === TOOLS.R_FLACC) {
    container.append(flaccUI(which));
  } else if (routed.tool === TOOLS.FPS_R) {
    container.append(facesUI(which));
  } else {
    container.append(numbersUI(which));
  }
}

const band = (n) => (n === 0 ? 'none' : n <= 3 ? 'mild' : n <= 6 ? 'moderate' : 'severe');

function numbersUI(which) {
  const wrap = el('div', {});
  const grid = el('div', { class: 'scale nrs' });
  for (let i = 0; i <= 10; i += 1) {
    grid.append(el('button', {
      class: `pt b-${band(i)}`, text: String(i),
      onclick: (e) => {
        answers[which] = i;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        refresh();
      },
    }));
  }
  wrap.append(grid, el('div', { class: 'anchors' },
    el('span', { text: 'no pain' }), el('span', { text: 'worst pain' })));
  return wrap;
}

function facesUI(which) {
  const wrap = el('div', {});
  const grid = el('div', { class: 'faces' });
  for (let i = 0; i < 6; i += 1) {
    grid.append(el('button', {
      class: 'face',
      onclick: (e) => {
        answers[which] = i * 2;
        [...grid.children].forEach((c) => c.classList.remove('on'));
        e.currentTarget.classList.add('on');
        refresh();
      },
    }, faceSvg(i)));
  }
  wrap.append(grid, el('div', { class: 'anchors' },
    el('span', { text: 'no pain' }), el('span', { text: 'very much pain' })));
  return wrap;
}

/** Line drawings only: no smile at one end, no tears at the other. */
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
  ['face', 'Face', ['No particular expression or smile', 'Occasional grimace or frown, withdrawn', 'Frequent frown, quivering chin, clenched jaw']],
  ['legs', 'Legs', ['Normal position, relaxed', 'Uneasy, restless, tense', 'Kicking, or legs drawn up']],
  ['activity', 'Activity', ['Lying quietly, moves easily', 'Squirming, shifting, tense', 'Arched, rigid, or jerking']],
  ['cry', 'Cry', ['No cry, awake or asleep', 'Moans or whimpers, occasional complaint', 'Crying steadily, screams or sobs']],
  ['consolability', 'Consolability', ['Content, relaxed', 'Reassured by touch or talk', 'Difficult to console']],
];

function flaccUI(which) {
  const store = which === 'rest' ? answers.flaccRest : answers.flaccMove;
  const wrap = el('div', {});
  const totalEl = el('div', { class: 'total' },
    el('span', { text: 'Total' }), el('span', { text: '—' }));

  FLACC.forEach(([key, label, options]) => {
    const opts = el('div', { class: 'flacc-opts' });
    options.forEach((text, score) => {
      opts.append(el('button', {
        class: 'flacc-opt',
        onclick: (e) => {
          store[key] = score;
          [...opts.children].forEach((c) => c.classList.remove('on'));
          e.currentTarget.classList.add('on');
          try {
            answers[which] = flaccTotal(store);
            totalEl.lastChild.textContent = `${answers[which]} / 10`;
          } catch {
            totalEl.lastChild.textContent = '—';
          }
          refresh();
        },
      }, el('b', { text: String(score) }), el('span', { text })));
    });
    wrap.append(el('div', { class: 'flacc-row' },
      el('div', { class: 'qlabel', text: label }), opts));
  });

  wrap.append(totalEl);
  return wrap;
}

/* ---------------- submit ---------------- */

function missing() {
  const out = [];
  if (!checkStudyNumber(answers.study).valid) out.push('the study number');
  if (!routed) out.push('the date of birth');
  if (!answers.timepoint) out.push('when this is');
  if (answers.rest == null) out.push('pain lying still');
  if (answers.move == null) out.push('pain when moving');
  if (answers.rescue == null) out.push('whether medicine was given');
  return out;
}

function refresh() {
  const gaps = missing();
  $('submit').disabled = gaps.length > 0;
  const why = $('why');
  if (gaps.length === 0 || gaps.length > 2) {
    why.hidden = true;
  } else {
    why.hidden = false;
    why.textContent = `Still needed: ${gaps.join(' and ')}.`;
  }
}

async function save() {
  $('submit').disabled = true;
  const now = new Date().toISOString();
  const { day, month, year } = answers.dob;
  const dobIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  await sync.submit({
    form: '05_pain_obs',
    studyNumber: answers.study,
    timepoint: answers.timepoint,
    data: {
      study_number: answers.study,
      date_of_birth: dobIso,
      assessed_at: now,
      tool_used: routed.tool,
      pain_rest: answers.rest,
      pain_dynamic: answers.move,
      flacc_rest: Object.keys(answers.flaccRest).length ? answers.flaccRest : null,
      flacc_dynamic: Object.keys(answers.flaccMove).length ? answers.flaccMove : null,
      rescue_given: answers.rescue,
      recorded_by: who,
    },
  });

  $('doneTitle').textContent = navigator.onLine ? 'Saved' : 'Saved on this phone';
  $('doneSub').textContent = navigator.onLine
    ? `${answers.study} · ${labelFor(answers.timepoint)}`
    : 'It will send itself when there is signal.';
  $('done').hidden = false;
}

const labelFor = (id) => {
  const tp = params().assessmentSchedule.timepoints.find((t) => t.id === id);
  return tp ? tp.label : 'Extra check';
};

function resetForm(newChild) {
  $('done').hidden = true;
  answers.timepoint = '';
  answers.rest = null;
  answers.move = null;
  answers.rescue = null;
  answers.flaccRest = {};
  answers.flaccMove = {};

  if (newChild) {
    answers.study = '';
    answers.dob = {};
    routed = null;
    $('study').value = '';
    $('study').className = 'mono';
    $('studyNote').textContent = '';
    ['dd', 'yy'].forEach((id) => { $(id).value = ''; });
    $('mm').value = '';
    $('ageNote').hidden = true;
    hideScales();
    $('study').focus();
  } else {
    drawScales();
  }

  [...$('timepoints').children].forEach((c) => c.classList.remove('on'));
  [...$('rescue').children].forEach((c) => c.classList.remove('on'));
  scrollTo({ top: 0, behavior: 'smooth' });
  refresh();
}

/* ---------------- the only status a nurse sees ---------------- */

function showPending(state) {
  if (state.rosterUpdated !== undefined) return;
  const badge = $('badge');
  const n = state.pending ?? 0;
  badge.textContent = n === 0 ? 'saved' : `${n} waiting`;
  badge.className = n === 0 ? 'badge' : 'badge waiting';
}

boot();
