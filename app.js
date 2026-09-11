/**
 * App shell: routing, the due-list home screen, and the M5 end-to-end path.
 *
 * Saving is local and immediate. Sync is invisible. The rater is never made to
 * wait for a network that a surgical camp does not have.
 */

import { loadParams, params } from './lib/params.js';
import { renderForm, el } from './lib/render.js';
import { buildDueList, dueListSummary, childSchedule, STATUS } from './lib/dueList.js';
import { roster, local, exportAll } from './lib/store.js';
import * as sync from './lib/sync.js';
import { validateStudyNumberField, validateDateOfBirth, warnEntryLag, summarise } from './lib/validate.js';
import { ageLabel } from './lib/age.js';

const APP_VERSION = '2026.09.11-p2';
const SETTINGS_KEY = 'ppp.device';

let CRF = null;
let settings = null;

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const backBtn = document.getElementById('back');

/* ---------------- boot ---------------- */

async function boot() {
  const [paramsJson, crfJson] = await Promise.all([
    fetch('./schema/params.json').then((r) => r.json()),
    fetch('./schema/crf.v1.json').then((r) => r.json()),
  ]);
  loadParams(paramsJson);
  CRF = crfJson;

  settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || {};

  // Collectors open a shared link on their own phone or laptop, so the device
  // is unknown in advance. Mint an id per browser install and keep it: it is
  // what makes "which handset produced this row" answerable during QC without
  // asking anyone to name their phone.
  if (!settings.deviceId) {
    settings.deviceId = 'dev-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  sync.configure({
    endpointUrl: settings.endpointUrl,
    token: settings.token,
    deviceId: settings.deviceId,
    raterId: settings.raterId,
    training: settings.calibrated !== true,
    schemaVersion: CRF.schemaVersion,
    paramsVersion: paramsJson.paramsVersion,
    appVersion: APP_VERSION,
  });

  sync.onChange(renderSyncBadge);
  sync.startAutoSync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  addEventListener('hashchange', route);
  document.getElementById('sync').addEventListener('click', async () => {
    toast('Syncing…');
    await sync.flush();
  });
  backBtn.addEventListener('click', () => history.back());
  document.querySelectorAll('#tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = btn.dataset.route; });
  });

  route();
}

/* ---------------- routing ---------------- */

const ROUTES = [
  [/^#\/due$/, screenDue],
  [/^#\/enrol$/, screenEnrol],
  [/^#\/children$/, screenChildren],
  [/^#\/settings$/, screenSettings],
  [/^#\/child\/([^/]+)$/, screenChild],
  [/^#\/assess\/([^/]+)\/([^/]+)$/, screenAssess],
];

function route() {
  const hash = location.hash || '#/due';
  view.style.paddingBottom = '110px';
  for (const [pattern, handler] of ROUTES) {
    const m = pattern.exec(hash);
    if (m) {
      backBtn.hidden = !hash.startsWith('#/child') && !hash.startsWith('#/assess');
      document.querySelectorAll('#tabs .tab').forEach((b) =>
        b.classList.toggle('on', b.dataset.route === hash));
      handler(...m.slice(1));
      return;
    }
  }
  location.hash = '#/due';
}

const setTitle = (title, sub = '') => {
  titleEl.textContent = title;
  subtitleEl.textContent = sub;
};

/* ---------------- due list ---------------- */

async function screenDue() {
  setTitle('Due now');
  const now = new Date().toISOString();
  const [children, observationsByChild] = await Promise.all([
    roster.all(), local.observationsByChild(),
  ]);

  const items = buildDueList({ roster: children, observationsByChild, now });
  const summary = dueListSummary(items);
  setTitle('Due now', `${summary.overdue} overdue · ${summary.due} due · ${summary.children} children`);

  view.replaceChildren();

  if (items.length === 0) {
    view.append(empty('No children enrolled on this device yet.',
      'Enrol a child, or sync to pull the camp roster.'));
    return;
  }

  const groups = [
    [STATUS.OVERDUE, 'Overdue'],
    [STATUS.DUE, 'Due now'],
    [STATUS.UPCOMING, 'Upcoming'],
  ];

  for (const [status, label] of groups) {
    const group = items.filter((i) => i.status === status);
    if (group.length === 0) continue;
    view.append(el('h2', { class: `group-title ${status}`, text: `${label} · ${group.length}` }));
    view.append(el('div', { class: 'cards' }, ...group.map(dueCard)));
  }
}

function dueCard(item) {
  const when = item.dueAt ? new Date(item.dueAt) : null;
  return el('button', {
    class: `card due-${item.status}`,
    onclick: () => { location.hash = `#/assess/${item.studyNumber}/${item.timepoint}`; },
  },
    el('div', { class: 'card-main' },
      el('span', { class: 'study-no mono', text: item.studyNumber }),
      el('span', { class: 'card-tp', text: item.label }),
    ),
    el('div', { class: 'card-meta' },
      el('span', { text: item.ageLabel || '—' }),
      el('span', { class: 'tool', text: toolName(item.tool) }),
      when ? el('span', { class: 'due-at', text: timeOf(when) }) : null,
    ),
    el('div', { class: 'card-progress' },
      el('span', { class: 'progress-bar' },
        el('span', { class: 'progress-fill', style: `width:${(item.completed / item.total) * 100}%` })),
      el('span', { class: 'progress-text', text: `${item.completed}/${item.total}` }),
      item.missedCount > 0 ? el('span', { class: 'missed', text: `${item.missedCount} missed` }) : null,
    ),
  );
}

const TOOL_NAMES = { flacc: 'FLACC', r_flacc: 'r-FLACC', fps_r: 'FPS-R', nrs: 'NRS', 'flacc+paed': 'FLACC + PAED' };
const toolName = (t) => TOOL_NAMES[t] || '—';
const timeOf = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ---------------- enrolment ---------------- */

async function screenEnrol() {
  setTitle('Enrol a child');
  const form = CRF.forms.find((f) => f.id === '01_enrolment');
  view.replaceChildren();

  const body = el('div', { class: 'form-body' });
  const footer = el('div', { class: 'form-footer' });
  view.append(body, footer);

  const controller = renderForm({
    form, container: body, record: {},
    context: { now: new Date().toISOString() },
    onChange: () => updateFooter(),
  });

  function extraIssues(record) {
    const issues = [];
    if (record.study_number) issues.push(...validateStudyNumberField(record.study_number));
    const dob = record.date_of_birth;
    if (dob?.year && dob?.month && dob?.day) {
      issues.push(...validateDateOfBirth(dob, new Date().toISOString()));
    }
    return issues;
  }

  function updateFooter() {
    const record = controller.getRecord();
    const base = controller.validate();
    const all = summarise([...base.blocks, ...base.warnings, ...extraIssues(record)]);
    footer.replaceChildren(
      ...all.blocks.slice(0, 3).map((b) => el('p', { class: 'issue block', text: b.message })),
      el('button', {
        class: 'primary', disabled: !all.canSubmit,
        text: all.canSubmit ? 'Enrol' : `${all.blocks.length} to fix`,
        onclick: () => saveEnrolment(record),
      }),
    );
    fitFooter();
  }

  updateFooter();
}

async function saveEnrolment(record) {
  const dob = record.date_of_birth;
  const iso = `${dob.year}-${String(dob.month).padStart(2, '0')}-${String(dob.day).padStart(2, '0')}`;

  await sync.submit({
    form: '01_enrolment',
    studyNumber: record.study_number,
    data: { ...record, date_of_birth: iso },
  });

  // The roster entry carries derived age, never the date of birth — except on
  // this device, where routing needs it and §02's controls apply.
  await roster.put({
    study_number: record.study_number,
    date_of_birth: iso,
    enrolled_at: record.enrolled_at || new Date().toISOString(),
    cognitive_impairment: false,
  });

  toast(`${record.study_number} enrolled`);
  location.hash = `#/child/${record.study_number}`;
}

/* ---------------- children ---------------- */

async function screenChildren() {
  setTitle('Children');
  const children = await roster.all();
  view.replaceChildren();
  if (children.length === 0) {
    view.append(empty('No children on this device.', 'Enrol one, or sync to pull the roster.'));
    return;
  }
  view.append(el('div', { class: 'cards' },
    ...children
      .sort((a, b) => String(a.study_number).localeCompare(String(b.study_number)))
      .map((c) => el('button', {
        class: 'card',
        onclick: () => { location.hash = `#/child/${c.study_number}`; },
      },
        el('div', { class: 'card-main' },
          el('span', { class: 'study-no mono', text: c.study_number }),
          el('span', { class: 'card-tp', text: c.procedure_category || '' })),
        el('div', { class: 'card-meta' },
          el('span', { text: c.date_of_birth ? ageLabel(c.date_of_birth, new Date().toISOString()) : '—' }),
          el('span', { text: c.anaesthesia_end ? 'in follow-up' : 'awaiting theatre' })),
      )),
  ));
}

async function screenChild(studyNumber) {
  setTitle(studyNumber, 'Record');
  const child = await roster.get(studyNumber);
  const records = await local.byChild(studyNumber);
  view.replaceChildren();

  if (!child) {
    view.append(empty('Not on this device.', 'Sync to pull the camp roster.'));
    return;
  }

  view.append(el('div', { class: 'detail' },
    row('Age', child.date_of_birth ? ageLabel(child.date_of_birth, new Date().toISOString()) : '—'),
    row('Procedure', child.procedure_category || '—'),
    row('Anaesthesia end', child.anaesthesia_end ? new Date(child.anaesthesia_end).toLocaleString() : 'not recorded'),
    row('Forms on device', String(records.length)),
  ));

  // The full schedule, not just what is due. Collection slips behind during
  // emergencies and at bad patient-to-clinician ratios, so a timepoint whose
  // window has closed must still be enterable — from notes, later. Hiding it
  // would mean the observation was made and then thrown away.
  const observations = (await local.observationsByChild())[studyNumber] || [];
  const schedule = childSchedule({ child, observations, now: new Date().toISOString() });
  const outstanding = schedule.filter((r) => r.status !== STATUS.DONE && r.status !== STATUS.UPCOMING);

  view.append(el('h2', { class: 'group-title', text: 'Assessments' }));
  view.append(el('div', { class: 'sched' },
    ...schedule.map((r) => el('button', {
      class: `sched-row ${r.status}`,
      onclick: () => { location.hash = `#/assess/${studyNumber}/${r.timepoint}`; },
    },
      el('span', { class: 'sched-label', text: r.label }),
      el('span', { class: `sched-status ${r.status}`, text: SCHED_LABEL[r.status] }),
    )),
  ));

  if (outstanding.some((r) => r.status === STATUS.MISSED)) {
    view.append(el('p', { class: 'help sched-note',
      text: 'Late timepoints can still be entered. Set the assessment time to when it actually happened, and say how it was recorded.' }));
  }

  const openable = CRF.forms.filter((f) => f.cardinality !== 'local' && f.id !== '01_enrolment' && f.id !== '05_pain_obs');
  view.append(el('h2', { class: 'group-title', text: 'Other forms' }));
  view.append(el('div', { class: 'cards' },
    ...openable.map((f) => el('button', {
      class: 'card slim',
      onclick: () => { location.hash = `#/assess/${studyNumber}/${f.id === '05_pain_obs' ? 'UNSCHED' : f.id}`; },
    },
      el('span', { text: f.title }),
      el('span', { class: 'count mono', text: String(records.filter((r) => r.form === f.id).length) }),
    )),
  ));
}

const SCHED_LABEL = {
  [STATUS.DONE]: 'recorded',
  [STATUS.OVERDUE]: 'due — late',
  [STATUS.DUE]: 'due now',
  [STATUS.MISSED]: 'enter late',
  [STATUS.UPCOMING]: 'not yet',
};

const row = (label, value) =>
  el('div', { class: 'detail-row' },
    el('span', { class: 'detail-label', text: label }),
    el('span', { class: 'detail-value', text: value }));

/* ---------------- assessment (M5 and any other form) ---------------- */

async function screenAssess(studyNumber, key) {
  const child = await roster.get(studyNumber);
  if (!child) { location.hash = '#/due'; return; }

  const isTimepoint = !CRF.forms.some((f) => f.id === key);
  const form = isTimepoint
    ? CRF.forms.find((f) => f.id === '05_pain_obs')
    : CRF.forms.find((f) => f.id === key);

  const tp = params().assessmentSchedule.timepoints.find((t) => t.id === key);
  setTitle(studyNumber, isTimepoint ? (tp?.label || 'Unscheduled') : form.title);

  view.replaceChildren();
  const body = el('div', { class: 'form-body' });
  const footer = el('div', { class: 'form-footer' });
  view.append(body, footer);

  const now = new Date().toISOString();
  const record = isTimepoint ? { timepoint: key, assessed_at: now } : {};

  const controller = renderForm({
    form, container: body, record,
    context: {
      now,
      dateOfBirth: child.date_of_birth,
      cognitiveImpairment: child.cognitive_impairment,
      weightKg: child.weight_kg,
      anaesthesiaEnd: child.anaesthesia_end,
      pacuArrival: child.pacu_arrival,
      blockAt: child.block_at,
      procedureCategory: child.procedure_category,
    },
    onChange: updateFooter,
  });

  function updateFooter() {
    const base = controller.validate();
    const record = controller.getRecord();
    const result = summarise([
      ...base.blocks, ...base.warnings,
      ...warnEntryLag(record, { now: new Date().toISOString() }),
    ]);
    footer.replaceChildren(
      ...result.blocks.slice(0, 3).map((b) => el('p', { class: 'issue block', text: b.message })),
      ...result.warnings.slice(0, 2).map((w) => el('p', { class: 'issue warn', text: w.message })),
      el('button', {
        class: 'primary', disabled: !result.canSubmit,
        text: result.canSubmit ? 'Save' : `${result.blocks.length} to fix`,
        onclick: async () => {
          const data = controller.getRecord();
          await sync.submit({
            form: form.id, studyNumber,
            timepoint: isTimepoint ? key : null,
            data,
          });
          await captureRosterFacts(studyNumber, form.id, data);
          toast('Saved');
          location.hash = '#/due';
        },
      }),
    );
    fitFooter();
  }

  updateFooter();
}

/**
 * A few fields are needed by every later screen — the anchors that drive the
 * due-list. Cache them on the roster entry as soon as they are recorded, so an
 * offline tablet does not need the server to know when assessments are due.
 */
async function captureRosterFacts(studyNumber, formId, data) {
  const child = await roster.get(studyNumber);
  if (!child) return;
  const next = { ...child };
  if (formId === '02_preop') {
    next.weight_kg = data.weight_kg ?? next.weight_kg;
    next.cognitive_impairment = data.cognitive_impairment === true;
    next.procedure_category = data.procedure_category ?? next.procedure_category;
  }
  if (formId === '03_intraop') {
    next.anaesthesia_end = data.anaesthesia_end ?? next.anaesthesia_end;
    next.block_at = data.block_at ?? next.block_at;
  }
  if (formId === '04_pacu_t0') {
    next.pacu_arrival = data.pacu_arrival_at ?? next.pacu_arrival;
  }
  await roster.put(next);
}

/* ---------------- settings ---------------- */

function screenSettings() {
  setTitle('Settings', `v${APP_VERSION}`);
  view.replaceChildren();

  const fields = [
    ['raterId', 'Your rater ID'],
    ['token', 'Your token'],
    ['endpointUrl', 'Endpoint URL'],
    ['siteCode', 'Site code'],
  ];

  const form = el('div', { class: 'form-body' },
    ...fields.map(([key, label]) =>
      el('div', { class: 'field' },
        el('label', { class: 'field-label', text: label }),
        el('input', {
          class: 'control', type: key === 'token' ? 'password' : 'text',
          value: settings[key] ?? '',
          oninput: (e) => { settings[key] = e.target.value; },
        }),
      )),
    el('div', { class: 'field' },
      el('label', { class: 'field-label', text: 'This device' }),
      el('output', { class: 'computed', text: settings.deviceId }),
      el('p', { class: 'help', text: 'Generated automatically. Quote it if a record needs tracing.' }),
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field-label', text: 'Rater has passed calibration' }),
      el('div', { class: 'segmented' },
        ...[['Yes', true], ['No', false]].map(([label, v]) =>
          el('button', {
            type: 'button', class: `seg ${settings.calibrated === v ? 'on' : ''}`, text: label,
            onclick: (e) => {
              settings.calibrated = v;
              e.target.parentElement.querySelectorAll('.seg').forEach((b) => b.classList.remove('on'));
              e.target.classList.add('on');
            },
          })),
      ),
      el('p', { class: 'help', text: 'Until this is yes, submissions are tagged training=1.' }),
    ),
  );

  const actions = el('div', { class: 'form-footer' },
    el('button', {
      class: 'primary', text: 'Save settings',
      onclick: () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        sync.configure({
          endpointUrl: settings.endpointUrl, token: settings.token,
          deviceId: settings.deviceId, raterId: settings.raterId,
          training: settings.calibrated !== true,
          schemaVersion: CRF.schemaVersion, paramsVersion: params().paramsVersion,
          appVersion: APP_VERSION,
        });
        toast('Saved');
      },
    }),
    el('button', {
      class: 'secondary', text: 'Check clock',
      onclick: async () => {
        try {
          const r = await sync.checkClock();
          toast(r.ok ? `Clock within ${Math.abs(r.skewSeconds)}s` : `Clock off by ${r.skewSeconds}s — fix before collecting`);
        } catch { toast('No connection'); }
      },
    }),
    el('button', {
      class: 'secondary', text: 'Export device data',
      onclick: async () => {
        const dump = await exportAll();
        const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `ppp-${settings.deviceId || 'device'}-${Date.now()}.json` });
        document.body.append(a); a.click(); a.remove();
      },
    }),
  );

  view.append(form, actions);
}

/* ---------------- chrome ---------------- */

function renderSyncBadge(state) {
  if (state.updateAvailable) { toast(`Update available (${state.updateAvailable})`); return; }
  // A roster pull can bring in children enrolled by someone else; the due list
  // is stale the moment that happens, so redraw it.
  if (state.rosterUpdated !== undefined) {
    if ((location.hash || '#/due') === '#/due') screenDue();
    return;
  }
  const dot = document.getElementById('sync-dot');
  const count = document.getElementById('pending');
  if (!dot || !count) return;
  count.textContent = String(state.pending ?? 0);
  dot.className = `dot ${state.syncing ? 'syncing' : state.online ? (state.pending ? 'pending' : 'clear') : 'offline'}`;
  document.getElementById('sync').title = state.online
    ? `${state.pending} waiting to sync`
    : 'Offline — saved on this device';
}

/**
 * The footer is fixed above the tab bar and grows with the number of issues, so
 * the scroll area has to be padded to match — otherwise the last field sits
 * permanently underneath it and cannot be reached.
 */
function fitFooter() {
  const footer = view.querySelector('.form-footer');
  view.style.paddingBottom = footer ? `${footer.offsetHeight + 70}px` : '110px';
}

const empty = (title, sub) =>
  el('div', { class: 'empty' },
    el('p', { class: 'empty-title', text: title }),
    el('p', { class: 'empty-sub', text: sub }));

let toastTimer = null;
function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2400);
}

boot();
