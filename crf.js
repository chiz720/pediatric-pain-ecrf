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
import { flaccTotal, paedTotal, bmi, localAnaestheticDose } from './lib/scoring.js';
import { validate as checkSubjectId } from './lib/studyNumber.js';
import * as sync from './lib/sync.js';

const APP_VERSION = '2026.09.11-crf';
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
const num = (id) => { const v = $(id).value; return v === '' ? null : Number(v); };

/** One child's form, held until each module is saved. */
const F = {
  subjectId: '', consent: new Set(), evalDate: '',
  m1: {}, m2: {}, m5: {},
  paed: {},                 // { P0: {...items}, P30: {...}, P60: {...} }
  ward: {},                 // { T2: {rest, move, rebound, rescue}, ... }
  paedTab: 'P0', wardTab: 'T2',
};
let who = null;
let routed = null;

/* ------------------------------------------------------------------ */

async function boot() {
  const paramsJson = await fetch('./schema/params.json').then((r) => r.json());
  loadParams(paramsJson);

  who = localStorage.getItem(WHO_KEY) || await askWho();
  $('who').textContent = `Evaluator: ${who}`;
  $('evaluator').textContent = who;
  $('changeWho').addEventListener('click', async () => {
    localStorage.removeItem(WHO_KEY);
    who = await askWho();
    $('who').textContent = `Evaluator: ${who}`;
    $('evaluator').textContent = who;
  });

  sync.configure({
    endpointUrl: CONFIG.endpointUrl, token: CONFIG.campKey,
    deviceId: deviceId(), raterId: who, training: false,
    schemaVersion: '1.0.0', paramsVersion: paramsJson.paramsVersion, appVersion: APP_VERSION,
  });
  sync.onChange(showPending);
  sync.startAutoSync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  $('evalDate').value = new Date().toISOString().slice(0, 10);
  F.evalDate = $('evalDate').value;
  $('evalDate').addEventListener('input', () => { F.evalDate = $('evalDate').value; });

  buildAdmin();
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

function askWho() {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'card', style: 'position:fixed;inset:0;z-index:40;margin:0;border-radius:0;overflow:auto;padding:28px 18px' },
      el('h2', { text: 'Who is the evaluator?' }),
      el('p', { class: 'explain', text: 'Tap your name. You will not be asked again on this phone.' }),
      el('div', { class: 'checks' },
        ...CONFIG.collectors.map((name) => el('button', {
          type: 'button', text: name,
          onclick: () => { localStorage.setItem(WHO_KEY, name); overlay.remove(); resolve(name); },
        }))));
    document.body.append(overlay);
  });
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
  const input = $('subjectId');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase();
    F.subjectId = input.value.trim();
    const note = $('subjectNote');
    if (!F.subjectId) { input.className = 'mono'; note.textContent = ''; return; }
    const r = checkSubjectId(F.subjectId);
    input.className = `mono ${r.valid ? 'ok' : 'bad'}`;
    note.textContent = r.valid ? '✓ check character matches' : 'Check the ID — the last character does not match.';
    note.className = `note ${r.valid ? 'ok' : 'bad'}`;
  });

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

  $('mypas').addEventListener('input', () => { F.m1.mypas_sf = num('mypas'); });
  $('caregiverVas').addEventListener('input', () => { F.m1.caregiver_vas = num('caregiverVas'); });
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
    toast('Enter a valid Subject ID first');
    $('subjectId').focus();
    scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  const header = {
    subject_id: F.subjectId,
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
