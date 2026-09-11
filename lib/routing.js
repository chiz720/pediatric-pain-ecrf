/**
 * Instrument routing.
 *
 * The rater never picks a pain scale. The app derives it from completed
 * calendar age plus the cognitive-impairment flag, re-evaluated at every
 * assessment so a child whose birthday falls mid-admission crosses instruments
 * correctly and visibly.
 */

import { params } from './params.js';
import { ageYears, ageMonths, ageLabel, isFuture } from './age.js';

export const TOOLS = {
  R_FLACC: 'r_flacc',
  FLACC: 'flacc',
  FPS_R: 'fps_r',
  NRS: 'nrs',
  FLACC_PAED: 'flacc+paed',
  NOT_ASSESSED: 'not_assessed',
};

/**
 * @param {object} ctx
 * @param {object|string} ctx.dateOfBirth
 * @param {object|string} ctx.assessedAt
 * @param {boolean} [ctx.cognitiveImpairment]
 * @param {boolean} [ctx.nonverbal]
 * @param {string}  [ctx.phase]  'pacu_t0' collects both instruments
 * @param {boolean} [ctx.asleep]
 * @returns {{tool: string, reason: string, years: number, label: string}}
 */
export function selectInstrument(ctx) {
  const p = params().routing;

  // The clinical form records age in completed months. A date of birth is
  // still accepted for anything that holds one, but months are the primary
  // path now.
  let months = ctx.ageMonths;
  let label;
  if (months == null) {
    if (isFuture(ctx.dateOfBirth, ctx.assessedAt)) {
      throw new Error('Assessment precedes date of birth');
    }
    months = ageMonths(ctx.dateOfBirth, ctx.assessedAt);
    label = ageLabel(ctx.dateOfBirth, ctx.assessedAt);
  } else {
    if (!Number.isFinite(months) || months < 0) throw new Error('Age in months must be zero or more');
    label = monthsLabel(months);
  }

  const years = Math.floor(months / 12);
  const out = (tool, reason) => ({ tool, reason, months, years, label });

  if (ctx.asleep) {
    return out(TOOLS.NOT_ASSESSED, 'Child asleep — assessment suppressed, reason code required');
  }
  if (ctx.phase === 'pacu_t0') {
    return out(TOOLS.FLACC_PAED, 'PACU arrival — FLACC and PAED are both mandatory at every age');
  }
  if (ctx.cognitiveImpairment) {
    return out(TOOLS.R_FLACC, 'Cognitive or developmental impairment — revised FLACC at any age');
  }
  if (ctx.nonverbal) {
    return out(TOOLS.FLACC, 'Nonverbal — observational scoring');
  }
  if (months <= p.flaccMaxMonths) {
    return out(TOOLS.FLACC, `${label} — under 4 years, watch the child`);
  }
  if (months <= p.fpsrMaxMonths) {
    return out(TOOLS.FPS_R, `${label} — ask the child to point at a face`);
  }
  return out(TOOLS.NRS, `${label} — ask the child for a number 0 to 10`);
}

/** "5 y 2 m", or "7 m" under a year. */
export function monthsLabel(months) {
  if (months < 12) return `${months} m`;
  return `${Math.floor(months / 12)} y ${months % 12} m`;
}

/** Enrolment eligibility on age alone. */
export function ageInRange(dateOfBirth, at) {
  const p = params().routing;
  const years = ageYears(dateOfBirth, at);
  if (isFuture(dateOfBirth, at)) return { inRange: false, reason: 'Date of birth is in the future' };
  if (years < p.minEnrolmentYears) return { inRange: false, reason: 'Below minimum age' };
  if (years > p.maxEnrolmentYears) return { inRange: false, reason: `Over ${p.maxEnrolmentYears} years` };
  return { inRange: true, years };
}

export function assentRequired(dateOfBirth, at) {
  return ageYears(dateOfBirth, at) >= params().routing.assentMinYears;
}

/** The string echoed back under the date-of-birth field at enrolment. */
export function ageEchoLabel(dateOfBirth, at) {
  const { label, tool } = selectInstrument({ dateOfBirth, assessedAt: at });
  const names = {
    [TOOLS.FLACC]: 'FLACC', [TOOLS.R_FLACC]: 'revised FLACC',
    [TOOLS.FPS_R]: 'FPS-R', [TOOLS.NRS]: 'NRS',
  };
  return `${label} — ${names[tool] || tool}`;
}
