/**
 * Instrument routing.
 *
 * The rater never picks a pain scale. The app derives it from completed
 * calendar age plus the cognitive-impairment flag, re-evaluated at every
 * assessment so a child whose birthday falls mid-admission crosses instruments
 * correctly and visibly.
 */

import { params } from './params.js';
import { ageYears, ageLabel, isFuture } from './age.js';

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
  const { dateOfBirth, assessedAt } = ctx;

  if (isFuture(dateOfBirth, assessedAt)) {
    throw new Error('Assessment precedes date of birth');
  }

  const years = ageYears(dateOfBirth, assessedAt);
  const label = ageLabel(dateOfBirth, assessedAt);
  const out = (tool, reason) => ({ tool, reason, years, label });

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
  if (years <= p.flaccMaxYears) {
    return out(TOOLS.FLACC, `Age ${label} — under ${p.fpsrMinYears} years, observational scoring`);
  }
  if (years <= p.fpsrMaxYears) {
    return out(TOOLS.FPS_R, `Age ${label} — self-report on Faces Pain Scale–Revised`);
  }
  return out(TOOLS.NRS, `Age ${label} — self-report on the 11-point Numerical Rating Scale`);
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
