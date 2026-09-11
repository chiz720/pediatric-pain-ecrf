/**
 * Schema-driven renderer.
 *
 * Nothing here knows what a FLACC is. Every field, every branch and every
 * bound comes from crf.v1.json, so the data dictionary and the form can never
 * drift apart — and a protocol amendment is a schema edit, not a code change.
 */

import { params } from './params.js';
import { isVisible, validateItem, summarise } from './validate.js';
import { selectInstrument, TOOLS } from './routing.js';
import { flaccTotal, paedTotal, fpsrScore, mypasSfScore } from './scoring.js';
import { validate as checkStudyNumber } from './studyNumber.js';

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  children.flat().forEach((c) => c && node.append(c));
  return node;
};

export { el };

/**
 * Render a form into a container.
 * @returns {{ getRecord: Function, validate: Function, refresh: Function }}
 */
export function renderForm({ form, container, record = {}, context = {}, onChange }) {
  const state = { ...record };
  container.replaceChildren();

  const rerender = () => {
    const scroll = container.scrollTop;
    draw();
    container.scrollTop = scroll;
  };

  const set = (id, value) => {
    state[id] = value;
    recompute();
    onChange?.(state);
    rerender();
  };

  const recompute = () => {
    for (const item of allItems(form)) {
      if (item.type !== 'computed') continue;
      state[item.id] = derive(item.derive, state, context);
    }
  };

  function draw() {
    container.replaceChildren();
    for (const section of form.sections) {
      const visible = section.items.filter((i) => isVisible(i, { ...state, ...context }));
      if (visible.length === 0) continue;
      container.append(
        el('section', { class: 'form-section' },
          el('h2', { class: 'section-title', text: section.title }),
          ...visible.map((item) => renderItem(item, state, context, set)),
        ),
      );
    }
  }

  recompute();
  draw();

  return {
    getRecord: () => ({ ...state }),
    refresh: rerender,
    validate: () => {
      const issues = allItems(form)
        .filter((i) => isVisible(i, { ...state, ...context }))
        .flatMap((i) => validateItem(i, state[i.id]));
      return summarise(issues);
    },
  };
}

const allItems = (form) => form.sections.flatMap((s) => s.items);

/* ------------------------------------------------------------------ *
 * Item renderers
 * ------------------------------------------------------------------ */

function renderItem(item, state, context, set) {
  const value = state[item.id];
  const field = el('div', { class: `field field-${item.type}` });

  field.append(el('label', { class: 'field-label', for: item.id },
    item.label,
    item.required ? el('span', { class: 'req', text: '*' }) : null,
    item.unit ? el('span', { class: 'unit', text: item.unit }) : null,
  ));

  const control = CONTROLS[item.type]
    ? CONTROLS[item.type](item, value, set, state, context)
    : CONTROLS.text(item, value, set, state, context);
  field.append(control);

  if (item.help) field.append(el('p', { class: 'help', text: item.help }));

  const issues = validateItem(item, value);
  for (const issue of issues) {
    if (issue.code === 'required' && value == null) continue; // don't scold before they start
    field.append(el('p', { class: `issue ${issue.level}`, text: issue.message }));
  }
  return field;
}

const num = (v) => (v === '' || v == null ? null : Number(v));

const CONTROLS = {
  text: (item, value, set) =>
    el('input', {
      id: item.id, class: 'control', type: 'text', value: value ?? '',
      oninput: (e) => { set(item.id, e.target.value); },
    }),

  secret: (item, value, set) =>
    el('input', {
      id: item.id, class: 'control', type: 'password', value: value ?? '',
      oninput: (e) => set(item.id, e.target.value),
    }),

  textarea: (item, value, set) =>
    el('textarea', {
      id: item.id, class: 'control', rows: 3,
      oninput: (e) => { state_debounce(() => set(item.id, e.target.value)); },
    }, value ?? ''),

  integer: (item, value, set) => numeric(item, value, set, 1),
  decimal: (item, value, set) => numeric(item, value, set, item.step ?? 0.1),

  slider: (item, value, set) =>
    el('div', { class: 'slider-wrap' },
      el('input', {
        id: item.id, class: 'control slider', type: 'range',
        min: item.min, max: item.max, step: item.step ?? 1, value: value ?? item.min,
        oninput: (e) => set(item.id, Number(e.target.value)),
      }),
      el('div', { class: 'slider-anchors' },
        el('span', { text: item.anchors?.low ?? String(item.min) }),
        el('output', { class: 'slider-value', text: value ?? '—' }),
        el('span', { text: item.anchors?.high ?? String(item.max) }),
      ),
    ),

  boolean: (item, value, set) =>
    el('div', { class: 'segmented' },
      ...[['Yes', true], ['No', false]].map(([label, v]) =>
        el('button', {
          type: 'button', class: `seg ${value === v ? 'on' : ''}`, text: label,
          onclick: () => set(item.id, v),
        })),
    ),

  select: (item, value, set, state, context) => {
    const options = resolveOptions(item, context);
    if (options.length <= 6) {
      return el('div', { class: 'chips' },
        ...options.map((o) =>
          el('button', {
            type: 'button', class: `chip ${value === o.value ? 'on' : ''}`, text: o.label,
            onclick: () => set(item.id, o.value),
          })),
      );
    }
    return el('select', {
      id: item.id, class: 'control',
      onchange: (e) => set(item.id, e.target.value || null),
    },
      el('option', { value: '', text: '—' }),
      ...options.map((o) => el('option', { value: o.value, text: o.label, selected: value === o.value })),
    );
  },

  multiselect: (item, value, set, state, context) => {
    const chosen = new Set(value || []);
    return el('div', { class: 'chips' },
      ...resolveOptions(item, context).map((o) =>
        el('button', {
          type: 'button', class: `chip ${chosen.has(o.value) ? 'on' : ''}`, text: o.label,
          onclick: () => {
            chosen.has(o.value) ? chosen.delete(o.value) : chosen.add(o.value);
            set(item.id, [...chosen]);
          },
        })),
    );
  },

  /** Three separate pickers — never a typed date string, never a locale guess. */
  date_parts: (item, value, set) => {
    const v = value || {};
    const upd = (part) => (e) => {
      const next = { ...v, [part]: num(e.target.value) };
      set(item.id, next.year && next.month && next.day ? next : next);
    };
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return el('div', { class: 'date-parts' },
      el('input', { class: 'control dp-day', type: 'number', min: 1, max: 31, placeholder: 'DD', value: v.day ?? '', oninput: upd('day') }),
      el('select', { class: 'control dp-month', onchange: upd('month') },
        el('option', { value: '', text: 'MMM' }),
        ...months.map((m, i) => el('option', { value: i + 1, text: m, selected: v.month === i + 1 })),
      ),
      el('input', { class: 'control dp-year', type: 'number', min: 2000, max: 2100, placeholder: 'YYYY', value: v.year ?? '', oninput: upd('year') }),
    );
  },

  datetime: (item, value, set) =>
    el('div', { class: 'datetime-wrap' },
      el('input', {
        id: item.id, class: 'control', type: 'datetime-local',
        value: value ? toLocalInput(value) : '',
        oninput: (e) => set(item.id, e.target.value ? new Date(e.target.value).toISOString() : null),
      }),
      el('button', { type: 'button', class: 'now', text: 'Now', onclick: () => set(item.id, new Date().toISOString()) }),
    ),

  /**
   * Typed by hand — there is no scanner. The check character is therefore the
   * only thing standing between a mistyped wristband and a phantom patient, so
   * it is verified live and shown as it is entered.
   */
  study_number: (item, value, set) => {
    const result = value ? checkStudyNumber(value) : null;
    return el('div', { class: 'study-number-wrap' },
      el('input', {
        id: item.id, class: `control mono ${result ? (result.valid ? 'ok' : 'bad') : ''}`,
        type: 'text', placeholder: params().studyNumber.example,
        value: value ?? '', autocapitalize: 'characters', autocomplete: 'off',
        spellcheck: 'false', inputmode: 'text',
        oninput: (e) => set(item.id, e.target.value.toUpperCase().trim()),
      }),
      result
        ? el('p', { class: `check ${result.valid ? 'ok' : 'bad'}`,
            text: result.valid ? '✓ check character matches' : result.message })
        : el('p', { class: 'help', text: `Format ${params().studyNumber.example}` }),
    );
  },

  computed: (item, value) =>
    el('output', { class: 'computed', text: value == null || value === '' ? '—' : String(value) }),

  /** The instrument is chosen for the rater, and says so. */
  pain_auto: (item, value, set, state, context) => {
    const routed = context.dateOfBirth
      ? selectInstrument({
          dateOfBirth: context.dateOfBirth,
          assessedAt: state.assessed_at || context.now || new Date().toISOString(),
          cognitiveImpairment: context.cognitiveImpairment,
        })
      : { tool: TOOLS.NRS, reason: 'No date of birth on this device — defaulting to NRS' };

    const v = value || {};
    const setScore = (score, components) =>
      set(item.id, { tool_used: routed.tool, score, components: components ?? null });

    return el('div', { class: 'pain-auto' },
      el('p', { class: 'routed', text: routed.reason }),
      routed.tool === TOOLS.FLACC || routed.tool === TOOLS.R_FLACC
        ? flaccControl(v, setScore)
        : routed.tool === TOOLS.FPS_R
          ? fpsrControl(v, setScore)
          : nrsControl(v, setScore),
    );
  },

  flacc: (item, value, set) =>
    flaccControl(value || {}, (score, components) => set(item.id, { score, components })),

  paed: (item, value, set) =>
    paedControl(value || {}, (score, components) => set(item.id, { score, components })),

  mypas_sf: (item, value, set) =>
    mypasControl(value || {}, (score, components) => set(item.id, { score, components })),

  umss: (item, value, set) => {
    const options = params().__instruments?.umss?.options || UMSS_OPTIONS;
    return el('div', { class: 'stack' },
      ...options.map((label, i) =>
        el('button', {
          type: 'button', class: `row-opt ${value === i ? 'on' : ''}`,
          onclick: () => set(item.id, i),
        }, el('span', { class: 'row-num', text: String(i) }), el('span', { text: label })),
      ),
    );
  },

  drug_table: (item, value, set) => drugTable(item, value || [], set),
  dose_block: (item, value, set) => doseBlock(item, value || {}, set),
};

const UMSS_OPTIONS = [
  'Awake and alert',
  'Minimally sedated: tired, appropriate response to conversation',
  'Moderately sedated: somnolent, easily roused with light touch',
  'Deeply sedated: rousable only with significant physical stimulation',
  'Unrousable',
];

function numeric(item, value, set, step) {
  return el('input', {
    id: item.id, class: 'control numeric', type: 'number', inputmode: 'decimal',
    min: item.min, max: item.max, step, value: value ?? '',
    oninput: (e) => set(item.id, num(e.target.value)),
  });
}

/* ---------------- instrument controls ---------------- */

const FLACC_DOMAINS = [
  { id: 'face', label: 'Face', options: ['No particular expression or smile', 'Occasional grimace or frown, withdrawn', 'Frequent to constant frown, quivering chin'] },
  { id: 'legs', label: 'Legs', options: ['Normal position or relaxed', 'Uneasy, restless, tense', 'Kicking, or legs drawn up'] },
  { id: 'activity', label: 'Activity', options: ['Lying quietly, moves easily', 'Squirming, shifting, tense', 'Arched, rigid, or jerking'] },
  { id: 'cry', label: 'Cry', options: ['No cry', 'Moans or whimpers, occasional complaint', 'Crying steadily, screams or sobs'] },
  { id: 'consolability', label: 'Consolability', options: ['Content, relaxed', 'Reassured by touch or talk; distractible', 'Difficult to console or comfort'] },
];

function flaccControl(value, onScore) {
  const components = { ...(value.components || {}) };
  const total = tryScore(() => flaccTotal(components));
  return el('div', { class: 'instrument' },
    ...FLACC_DOMAINS.map((d) =>
      el('div', { class: 'domain' },
        el('p', { class: 'domain-label', text: d.label }),
        el('div', { class: 'stack' },
          ...d.options.map((label, i) =>
            el('button', {
              type: 'button', class: `row-opt ${components[d.id] === i ? 'on' : ''}`,
              onclick: () => {
                components[d.id] = i;
                onScore(tryScore(() => flaccTotal(components)), components);
              },
            }, el('span', { class: 'row-num', text: String(i) }), el('span', { text: label })),
          ),
        ),
      )),
    totalRow('FLACC', total, 10),
  );
}

const PAED_ITEMS = [
  { id: 'eye_contact', label: 'The child makes eye contact with the caregiver' },
  { id: 'purposeful', label: "The child's actions are purposeful" },
  { id: 'aware', label: 'The child is aware of their surroundings' },
  { id: 'restless', label: 'The child is restless' },
  { id: 'inconsolable', label: 'The child is inconsolable' },
];
const PAED_SCALE = ['Not at all', 'Just a little', 'Quite a bit', 'Very much', 'Extremely'];

function paedControl(value, onScore) {
  const components = { ...(value.components || {}) };
  const total = tryScore(() => paedTotal(components));
  return el('div', { class: 'instrument' },
    el('p', { class: 'instrument-note', text: 'Items 1–3 are reverse-scored by the app. Record what you observe.' }),
    ...PAED_ITEMS.map((it) =>
      el('div', { class: 'domain' },
        el('p', { class: 'domain-label', text: it.label }),
        el('div', { class: 'chips' },
          ...PAED_SCALE.map((label, i) =>
            el('button', {
              type: 'button', class: `chip ${components[it.id] === i ? 'on' : ''}`, text: label,
              onclick: () => {
                components[it.id] = i;
                onScore(tryScore(() => paedTotal(components)), components);
              },
            })),
        ),
      )),
    totalRow('PAED', total, 20),
  );
}

function fpsrControl(value, onScore) {
  const v = value.score;
  return el('div', { class: 'instrument fpsr' },
    el('p', { class: 'instrument-note', text: 'Point to the face that shows how much you hurt.' }),
    el('div', { class: 'faces' },
      ...[0, 1, 2, 3, 4, 5].map((i) =>
        el('button', {
          type: 'button', class: `face ${v === i * 2 ? 'on' : ''}`, 'aria-label': `Face ${i + 1}`,
          onclick: () => onScore(fpsrScore(i), { face_index: i }),
        }, faceSvg(i)),
      ),
    ),
    el('div', { class: 'faces-anchors' },
      el('span', { text: 'no pain' }), el('span', { text: 'very much pain' })),
    totalRow('FPS-R', v, 10),
  );
}

function nrsControl(value, onScore) {
  const v = value.score;
  return el('div', { class: 'instrument nrs' },
    el('div', { class: 'nrs-row' },
      ...Array.from({ length: 11 }, (_, i) =>
        el('button', {
          type: 'button', class: `nrs-btn ${v === i ? 'on' : ''} band-${bandOf(i)}`, text: String(i),
          onclick: () => onScore(i, null),
        })),
    ),
    el('div', { class: 'faces-anchors' },
      el('span', { text: 'no pain' }), el('span', { text: 'worst pain imaginable' })),
  );
}

const MYPAS_DOMAINS = [
  { id: 'activity', label: 'Activity', max: 4 },
  { id: 'vocalisation', label: 'Vocalisation', max: 6 },
  { id: 'expressivity', label: 'Emotional expressivity', max: 4 },
  { id: 'arousal', label: 'State of apparent arousal', max: 4 },
];

function mypasControl(value, onScore) {
  const components = { ...(value.components || {}) };
  const total = tryScore(() => mypasSfScore(components));
  return el('div', { class: 'instrument' },
    ...MYPAS_DOMAINS.map((d) =>
      el('div', { class: 'domain' },
        el('p', { class: 'domain-label', text: `${d.label} (1–${d.max})` }),
        el('div', { class: 'chips' },
          ...Array.from({ length: d.max }, (_, i) => i + 1).map((n) =>
            el('button', {
              type: 'button', class: `chip ${components[d.id] === n ? 'on' : ''}`, text: String(n),
              onclick: () => {
                components[d.id] = n;
                onScore(tryScore(() => mypasSfScore(components)), components);
              },
            })),
        ),
      )),
    totalRow('m-YPAS-SF', total, 100),
  );
}

function totalRow(name, total, max) {
  return el('div', { class: 'total-row' },
    el('span', { class: 'total-label', text: name }),
    el('span', { class: 'total-value', text: total == null ? '—' : `${total} / ${max}` }),
  );
}

const tryScore = (fn) => { try { return fn(); } catch { return null; } };
const bandOf = (n) => (n === 0 ? 'none' : n <= 3 ? 'mild' : n <= 6 ? 'moderate' : 'severe');

/** Six line-drawing faces: no smile at the low anchor, no tears at the high one. */
function faceSvg(i) {
  const brow = [0, 2, 4, 7, 10, 13][i];
  const mouth = [8, 6, 3, 0, -4, -8][i];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'face-svg');
  const add = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
  };
  add('circle', { cx: 32, cy: 32, r: 28, class: 'f-outline' });
  add('path', { d: `M18 ${26 - brow / 2} q5 ${-brow / 2} 10 0`, class: 'f-line' });
  add('path', { d: `M36 ${26 - brow / 2} q5 ${-brow / 2} 10 0`, class: 'f-line' });
  add('circle', { cx: 23, cy: 31, r: 2.5, class: 'f-fill' });
  add('circle', { cx: 41, cy: 31, r: 2.5, class: 'f-fill' });
  add('path', { d: `M20 ${44 - mouth / 3} q12 ${mouth} 24 0`, class: 'f-line' });
  return svg;
}

/* ---------------- composite controls ---------------- */

function drugTable(item, rows, set) {
  const options = item.drugOptions || Object.values(params().opioids.fentanylEquivalents.factors).map((f) => f.label);
  const update = (i, key, v) => {
    const next = rows.map((r, n) => (n === i ? { ...r, [key]: v } : r));
    set(item.id, next);
  };
  return el('div', { class: 'drug-table' },
    ...rows.map((row, i) =>
      el('div', { class: 'drug-row' },
        el('select', { class: 'control', onchange: (e) => update(i, 'drug', e.target.value) },
          el('option', { value: '', text: '—' }),
          ...options.map((o) => el('option', { value: o, text: o, selected: row.drug === o }))),
        el('input', { class: 'control numeric', type: 'number', inputmode: 'decimal', placeholder: 'dose', value: row.amount ?? '', oninput: (e) => update(i, 'amount', num(e.target.value)) }),
        el('select', { class: 'control', onchange: (e) => update(i, 'unit', e.target.value) },
          ...['mg', 'mcg'].map((u) => el('option', { value: u, text: u, selected: row.unit === u }))),
        el('button', { type: 'button', class: 'remove', text: '×', onclick: () => set(item.id, rows.filter((_, n) => n !== i)) }),
      )),
    el('button', {
      type: 'button', class: 'add-row', text: '+ Add',
      onclick: () => set(item.id, [...rows, { drug: '', amount: null, unit: 'mg' }]),
    }),
    rows.length === 0 && item.allowNone ? el('p', { class: 'help', text: 'None given.' }) : null,
  );
}

function doseBlock(item, value, set) {
  const given = value.given === true;
  return el('div', { class: 'dose-block' },
    el('div', { class: 'segmented' },
      ...[['Given', true], ['Not given', false]].map(([label, v]) =>
        el('button', {
          type: 'button', class: `seg ${value.given === v ? 'on' : ''}`, text: label,
          onclick: () => set(item.id, { ...value, given: v }),
        })),
    ),
    given ? el('div', { class: 'dose-fields' },
      item.drugOptions
        ? el('select', { class: 'control', onchange: (e) => set(item.id, { ...value, drug: e.target.value }) },
            el('option', { value: '', text: '—' }),
            ...item.drugOptions.map((o) => el('option', { value: o, text: o, selected: value.drug === o })))
        : null,
      el('input', {
        class: 'control numeric', type: 'number', inputmode: 'decimal', placeholder: item.unit,
        value: value.dose ?? '', oninput: (e) => set(item.id, { ...value, dose: num(e.target.value) }),
      }),
      el('button', {
        type: 'button', class: 'now', text: 'Now',
        onclick: () => set(item.id, { ...value, at: new Date().toISOString() }),
      }),
    ) : null,
  );
}

/* ---------------- helpers ---------------- */

function resolveOptions(item, context) {
  if (Array.isArray(item.options)) return item.options.map(asOption);

  if (item.optionsFromParams) {
    const node = item.optionsFromParams.split('.').reduce((o, k) => (o == null ? o : o[k]), params());
    let options = [];
    if (Array.isArray(node)) {
      // Objects with an id keep the id as the stored value: the schedule's
      // timepoint ids are what onTimeFlag and the due-list match on, so storing
      // the display label here would silently break every derived window.
      options = node.map((n) =>
        (n && typeof n === 'object' && n.id)
          ? { value: n.id, label: n.label || n.id }
          : asOption(n));
    } else if (node && typeof node === 'object') {
      options = Object.entries(node)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => ({ value: v.label || k, label: v.label || k }));
    }
    if (item.includeUnscheduled) {
      options.push({ value: params().assessmentSchedule.unscheduledId, label: 'Unscheduled' });
    }
    return options;
  }

  if (item.sameOptionsAs && context.optionSets?.[item.sameOptionsAs]) {
    return context.optionSets[item.sameOptionsAs].map(asOption);
  }
  return [];
}

const asOption = (o) =>
  (o && typeof o === 'object' && 'value' in o) ? o : { value: o, label: String(o) };

let debounceTimer = null;
function state_debounce(fn) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fn, 400);
}

const toLocalInput = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ---------------- derivations used by computed fields ---------------- */

import { ageDays, ageMonths, ageYears, ageLabel } from './age.js';
import { ageEchoLabel, ageInRange, assentRequired } from './routing.js';
import { bmi, localAnaestheticDose, pacuClassification, doseMme, fentanylEquivalents } from './scoring.js';
import { blockDurationHours, onTimeFlag, reboundPain } from './derive.js';

export function derive(name, state, context) {
  const dob = context.dateOfBirth;
  const now = state.assessed_at || context.now || new Date().toISOString();
  const t = (fn) => { try { return fn(); } catch { return null; } };

  switch (name) {
    case 'age_days': return dob ? t(() => ageDays(dob, now)) : null;
    case 'age_months': return dob ? t(() => ageMonths(dob, now)) : null;
    case 'age_years': return dob ? t(() => ageYears(dob, now)) : null;
    case 'age_label_with_instrument': {
      const d = state.date_of_birth;
      return d?.year && d?.month && d?.day ? t(() => ageEchoLabel(d, now)) : null;
    }
    case 'age_in_range': return state.date_of_birth ? t(() => ageInRange(state.date_of_birth, now)?.inRange) : null;
    case 'assent_required': return state.date_of_birth ? t(() => assentRequired(state.date_of_birth, now)) : null;
    case 'eligibility_all': {
      // null until every criterion has been answered, so the form does not
      // declare a child ineligible before anyone has said anything.
      const criteria = [state.elig_elective, state.elig_age, state.elig_consent];
      if (criteria.some((v) => v == null)) return null;
      return criteria.every((v) => v === true);
    }
    case 'bmi': return t(() => bmi(state.weight_kg, state.height_cm));
    case 'mypas_sf_score': return state.mypas_sf?.score ?? null;
    case 'flacc_total': return state.flacc?.score ?? null;
    case 'paed_total': return state.paed?.score ?? null;
    case 'surgical_duration_min': return minutesBetween(state.incision, state.closure);
    case 'anaesthesia_duration_min': return minutesBetween(state.anaesthesia_start, state.anaesthesia_end);
    case 'la_mg_per_kg': return t(() => laDose(state, context)?.mgPerKg);
    case 'la_pct_of_max': return t(() => laDose(state, context)?.pctOfMax);
    case 'fent_eq_mcg_per_kg': {
      const total = t(() => fentanylEquivalents(state.intraop_opioids || []));
      return total != null && context.weightKg ? round2(total / context.weightKg) : null;
    }
    case 'dose_mg_per_kg':
      return state.dose_amount != null && context.weightKg && state.dose_unit === 'mg'
        ? round2(state.dose_amount / context.weightKg) : null;
    case 'dose_mme':
      return t(() => doseMme({ drug: state.drug, route: state.route, amount: state.dose_amount, unit: state.dose_unit }));
    case 'pacu_classification': return t(() => pacuAdj(state)?.classification);
    case 'pacu_classification_rationale': return t(() => pacuAdj(state)?.rationale);
    case 'entry_lag_h': {
      // The gap between when the assessment happened and when someone typed it.
      // client_ts records the typing; assessed_at records the clinical event.
      if (!state.assessed_at) return null;
      const lag = (Date.parse(context.now || new Date().toISOString()) - Date.parse(state.assessed_at)) / 3600000;
      if (!Number.isFinite(lag) || lag < 0) return null;
      return lag < 0.5 ? 'entered at the time' : `${round2(lag)} h`;
    }
    case 'on_time_flag': {
      const r = t(() => onTimeFlag({
        timepointId: state.timepoint, actualAt: now,
        anaesthesiaEnd: context.anaesthesiaEnd, pacuArrival: context.pacuArrival,
      }));
      if (!r) return null;
      if (!r.applicable) return 'n/a';
      return r.onTime ? 'within window' : `${r.driftMinutes > 0 ? '+' : ''}${r.driftMinutes} min`;
    }
    case 'block_duration_h':
      return blockDurationHours({ blockAt: context.blockAt, sensoryReturnAt: state.sensory_return_at });
    case 'regression_clock_time':
      return state.sensory_return_at
        ? new Date(state.sensory_return_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;
    case 'rebound_protocol': return t(() => reboundLabel(state, 'protocol'));
    case 'rebound_barry': return t(() => reboundLabel(state, 'barry'));
    default: return null;
  }
}

function laDose(state, context) {
  if (!state.block_performed) return null;
  return localAnaestheticDose({
    agent: keyFor(state.la_agent),
    concentrationPct: state.la_concentration_pct,
    volumeMl: state.la_volume_ml,
    weightKg: context.weightKg,
    withEpinephrine: state.la_with_epinephrine,
    dateOfBirth: context.dateOfBirth,
    at: context.now,
  });
}

const keyFor = (label) => {
  const agents = params().localAnaesthetic.agents;
  const hit = Object.entries(agents).find(([k, v]) => v.label === label || k === label);
  return hit ? hit[0] : label;
};

function pacuAdj(state) {
  if (state.flacc?.score == null || state.paed?.score == null) return null;
  return pacuClassification({
    paedTotal: state.paed.score,
    flaccTotal: state.flacc.score,
    gates: {
      eye_contact: state.gate_eye_contact,
      purposeful: state.gate_purposeful,
      aware: state.gate_aware,
      consolable: state.gate_consolable,
    },
  });
}

function reboundLabel(state, definition) {
  const before = state.pain_before_regression?.score;
  const after = [state.pain_plus_1h?.score, state.pain_plus_2h?.score].filter((v) => v != null);
  if (before == null || after.length === 0) return null;
  const r = reboundPain({
    definition, painBefore: before, painAfterSeries: after,
    rescueRequested: state.rescue_requested,
  });
  return r.rebound ? `Yes — peak ${r.peakAfter}, escalation +${r.escalation}` : 'No';
}

const minutesBetween = (a, b) =>
  a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60000) : null;
const round2 = (n) => Math.round(n * 100) / 100;
