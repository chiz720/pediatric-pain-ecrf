/**
 * Validation.
 *
 * Two tiers, deliberately distinct:
 *   BLOCK — the submit button stays disabled. Reserved for entries that are
 *           almost certainly a data-entry error or that would be unsafe to act
 *           on. A block that fires on real clinical data will be worked around
 *           by ward staff, so the list is kept short.
 *   WARN  — shown, acknowledged, and recorded. The record still submits.
 */

import { params } from './params.js';
import { ageYears, isFuture, toDate } from './age.js';
import { localAnaestheticDose, restrictedForAge, respiratoryDepression } from './scoring.js';
import { validate as validateStudyNumber } from './studyNumber.js';

export const BLOCK = 'block';
export const WARN = 'warn';

const issue = (level, field, code, message) => ({ level, field, code, message });

/* ------------------------------------------------------------------ *
 * Field-level: range, type and format
 * ------------------------------------------------------------------ */

export function validateItem(item, value) {
  const issues = [];
  const missing = value === null || value === undefined || value === '';

  if (item.required && missing) {
    return [issue(BLOCK, item.id, 'required', `${item.label} is required.`)];
  }
  if (missing) return issues;

  if (item.type === 'integer' && !Number.isInteger(value)) {
    issues.push(issue(BLOCK, item.id, 'type', `${item.label} must be a whole number.`));
  }
  if ((item.type === 'integer' || item.type === 'decimal' || item.type === 'slider') && Number.isFinite(value)) {
    if (item.min != null && value < item.min) {
      issues.push(issue(BLOCK, item.id, 'min', `${item.label} cannot be below ${item.min}${item.unit ? ' ' + item.unit : ''}.`));
    }
    if (item.max != null && value > item.max) {
      issues.push(issue(BLOCK, item.id, 'max', `${item.label} cannot be above ${item.max}${item.unit ? ' ' + item.unit : ''}.`));
    }
  }
  if (item.pattern && !new RegExp(item.pattern).test(String(value))) {
    issues.push(issue(BLOCK, item.id, 'pattern', `${item.label} is not in the expected format.`));
  }
  if (item.type === 'select' && Array.isArray(item.options) && !item.options.includes(value)) {
    issues.push(issue(BLOCK, item.id, 'option', `${value} is not an option for ${item.label}.`));
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Branching
 * ------------------------------------------------------------------ */

export function isVisible(item, record) {
  const cond = item.showIf;
  if (!cond) return true;
  const actual = record[cond.field];
  switch (cond.op) {
    case 'eq': return actual === cond.value;
    case 'ne': return actual !== cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(actual);
    case 'gte': return Number(actual) >= Number(cond.value);
    case 'lte': return Number(actual) <= Number(cond.value);
    case 'truthy': return Boolean(actual);
    case 'differs_from': return actual !== record[cond.value];
    default: throw new Error(`Unknown showIf operator: ${cond.op}`);
  }
}

/** Required-by-branch: a hidden field is never required. */
export function validateSection(section, record) {
  return section.items
    .filter((item) => isVisible(item, record))
    .flatMap((item) => validateItem(item, record[item.id]));
}

export function validateForm(form, record) {
  return form.sections.flatMap((section) => validateSection(section, record));
}

/* ------------------------------------------------------------------ *
 * Cross-field clinical rules
 * ------------------------------------------------------------------ */

export function validateDateOfBirth(dob, now) {
  const issues = [];
  let parsed;
  try {
    parsed = toDate(dob);
  } catch (err) {
    return [issue(BLOCK, 'date_of_birth', 'unparseable', err.message)];
  }
  if (isFuture(parsed, now)) {
    issues.push(issue(BLOCK, 'date_of_birth', 'future_date', 'Date of birth is in the future.'));
    return issues;
  }
  const years = ageYears(parsed, now);
  const max = params().routing.maxEnrolmentYears;
  if (years > max) {
    issues.push(issue(BLOCK, 'date_of_birth', 'age_over_max',
      `Computed age is ${years} years, above the protocol maximum of ${max}. Check the year.`));
  }
  return issues;
}

export function validateStudyNumberField(value) {
  const result = validateStudyNumber(value);
  return result.valid ? [] : [issue(BLOCK, 'study_number', result.reason, result.message)];
}

/** Closure cannot precede incision, and nothing may be in the future. */
export function validateTimestampSequence(record, fields, now) {
  const issues = [];
  const present = fields.filter((f) => record[f] != null);

  for (const f of present) {
    if (now != null && new Date(record[f]).getTime() > new Date(now).getTime() + 60000) {
      issues.push(issue(BLOCK, f, 'future_timestamp', 'Timestamp is in the future.'));
    }
  }
  for (let i = 1; i < present.length; i += 1) {
    const prev = present[i - 1], cur = present[i];
    if (new Date(record[cur]).getTime() < new Date(record[prev]).getTime()) {
      issues.push(issue(BLOCK, cur, 'out_of_sequence',
        `${cur.replace(/_/g, ' ')} cannot precede ${prev.replace(/_/g, ' ')}.`));
    }
  }
  return issues;
}

export function validateLocalAnaesthetic(record, context) {
  if (!record.block_performed) return [];
  let dose;
  try {
    dose = localAnaestheticDose({
      agent: record.la_agent,
      concentrationPct: record.la_concentration_pct,
      volumeMl: record.la_volume_ml,
      weightKg: context.weightKg,
      withEpinephrine: record.la_with_epinephrine,
      dateOfBirth: context.dateOfBirth,
      at: context.at,
    });
  } catch (err) {
    return [issue(BLOCK, 'la_volume_ml', 'la_uncomputable', err.message)];
  }
  if (dose.verdict === 'block') return [issue(BLOCK, 'la_volume_ml', 'la_over_max', dose.message)];
  if (dose.verdict === 'warn') return [issue(WARN, 'la_volume_ml', 'la_near_max', dose.message)];
  return [];
}

/** A duplicate scheduled timepoint for the same child is always an error. */
export function validateNoDuplicateTimepoint(record, existingRows) {
  const unscheduled = params().assessmentSchedule.unscheduledId;
  if (record.timepoint === unscheduled) return [];
  const clash = (existingRows || []).some(
    (r) => r.timepoint === record.timepoint
      && r.study_number === record.study_number
      && r.submission_uuid !== record.submission_uuid,
  );
  return clash
    ? [issue(BLOCK, 'timepoint', 'duplicate_timepoint',
        `${record.timepoint} is already recorded for this child. Open the existing record to correct it.`)]
    : [];
}

export function validateGatekeeper(studyNumber, enrolledSet) {
  return enrolledSet.has(studyNumber)
    ? []
    : [issue(BLOCK, 'study_number', 'not_enrolled',
        'This study number has no completed enrolment form. Complete enrolment first.')];
}

/* ------------------------------------------------------------------ *
 * Soft warnings
 * ------------------------------------------------------------------ */

const WEIGHT_BOUNDS = [
  { maxYears: 0,    lo: 2,  hi: 14 },
  { maxYears: 3,    lo: 6,  hi: 25 },
  { maxYears: 7,    lo: 10, hi: 45 },
  { maxYears: 12,   lo: 15, hi: 75 },
  { maxYears: null, lo: 25, hi: 120 },
];

export function warnImplausibleWeight(weightKg, dateOfBirth, at) {
  const years = ageYears(dateOfBirth, at);
  const band = WEIGHT_BOUNDS.find((b) => b.maxYears === null || years <= b.maxYears);
  if (weightKg < band.lo || weightKg > band.hi) {
    return [issue(WARN, 'weight_kg', 'weight_implausible',
      `${weightKg} kg is outside the usual ${band.lo}-${band.hi} kg range at ${years} years. Confirm the scale reading.`)];
  }
  return [];
}

export function warnPainJump(current, previous) {
  if (previous == null || current == null) return [];
  const delta = Math.abs(current - previous);
  return delta >= 5
    ? [issue(WARN, 'pain_rest', 'pain_jump',
        `Pain has moved ${delta} points since the last assessment. Confirm this is the score you mean.`)]
    : [];
}

export function warnDynamicBelowRest(rest, dynamic) {
  if (rest == null || dynamic == null) return [];
  return dynamic < rest
    ? [issue(WARN, 'pain_dynamic', 'dynamic_below_rest',
        'Pain on movement is lower than pain at rest, which is unusual. Confirm both scores.')]
    : [];
}

/**
 * Retrospective entry is expected — camp staffing and emergencies mean some
 * assessments are written down and typed up later. What must not happen is a
 * record claiming to be bedside when it was entered hours afterwards, or an
 * assessed_at left at its default when the observation was actually made
 * earlier. Both corrupt every derived interval in the study.
 */
export function warnEntryLag(record, context) {
  const cfg = params().dataCapture;
  if (!record.assessed_at) return [];

  const enteredAt = context?.now || new Date().toISOString();
  const lagHours = (Date.parse(enteredAt) - Date.parse(record.assessed_at)) / 3600000;
  if (!Number.isFinite(lagHours)) return [];

  const issues = [];
  const rounded = Math.round(lagHours * 10) / 10;

  if (lagHours > cfg.entryLagWarnHours && record.entry_mode === cfg.entryModes[0]) {
    issues.push(issue(WARN, 'entry_mode', 'entry_lag_disagrees',
      `This says it was recorded at the bedside, but it is being entered ${rounded} h later. `
      + 'Either correct the assessment time, or change how it was recorded.'));
  }
  if (record.entry_mode === cfg.entryModes[2] && lagHours > cfg.recallModeMaxHours) {
    issues.push(issue(WARN, 'entry_mode', 'recall_too_old',
      `Recalled ${rounded} h after the event. This will be flagged for QC and may be excluded.`));
  }
  return issues;
}

export function warnRespiratoryDepression(record, context) {
  const rd = respiratoryDepression({
    respiratoryRate: record.rr,
    spo2: record.spo2,
    naloxoneGiven: record.naloxone_given,
    dateOfBirth: context.dateOfBirth,
    at: context.at,
  });
  return rd.triggered
    ? [issue(WARN, 'rr', 'respiratory_depression',
        `${rd.reasons.join(' ')} Open an adverse event record.`)]
    : [];
}

export function warnRestrictedDrug(record, context) {
  const r = restrictedForAge({
    drug: record.drug, route: record.route,
    dateOfBirth: context.dateOfBirth, at: record.given_at,
    procedureCategory: context.procedureCategory,
  });
  return r.restricted ? [issue(WARN, 'drug', 'restricted_for_age', r.message)] : [];
}

export function warnPaedOutsidePacu(record, formId) {
  if (formId === '04_pacu_t0') return [];
  const t = params().thresholds;
  return record.paed_total != null && record.paed_total >= t.paedEdCutoff
    ? [issue(WARN, 'paed_total', 'paed_outside_pacu',
        `PAED ${record.paed_total} recorded outside the PACU phase. Confirm the child is in emergence.`)]
    : [];
}

export function warnAldrete(record) {
  const t = params().thresholds;
  return record.aldrete != null && record.aldrete < t.aldreteDischarge && record.pacu_discharge_at != null
    ? [issue(WARN, 'pacu_discharge_at', 'aldrete_below_threshold',
        `Aldrete ${record.aldrete} is below the discharge threshold of ${t.aldreteDischarge}.`)]
    : [];
}

/* ------------------------------------------------------------------ */

export function summarise(issues) {
  return {
    blocks: issues.filter((i) => i.level === BLOCK),
    warnings: issues.filter((i) => i.level === WARN),
    canSubmit: !issues.some((i) => i.level === BLOCK),
  };
}
