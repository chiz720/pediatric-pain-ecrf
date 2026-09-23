/**
 * Instrument scoring and point-of-entry dose arithmetic.
 *
 * Every function here is pure and total: it either returns a value or throws.
 * Totals are computed from itemised responses, never typed by a rater, and are
 * recomputed server-side from the same raw inputs.
 */

import { params } from './params.js';
import { ageYears, ageMonths } from './age.js';

const FLACC_DOMAINS = ['face', 'legs', 'activity', 'cry', 'consolability'];
const PAED_ITEMS = [
  { id: 'eye_contact', reverse: true },
  { id: 'purposeful', reverse: true },
  { id: 'aware', reverse: true },
  { id: 'restless', reverse: false },
  { id: 'inconsolable', reverse: false },
];
const MYPAS_DOMAINS = [
  { id: 'activity', max: 4 },
  { id: 'vocalisation', max: 6 },
  { id: 'expressivity', max: 4 },
  { id: 'arousal', max: 4 },
];

function requireInt(value, lo, hi, what) {
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new Error(`${what} must be an integer ${lo}-${hi}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** FLACC / revised FLACC: five domains scored 0-2, total 0-10. */
export function flaccTotal(domains) {
  if (!domains || typeof domains !== 'object') throw new Error('FLACC: expected five domain scores');
  return FLACC_DOMAINS.reduce(
    (sum, d) => sum + requireInt(domains[d], 0, 2, `FLACC ${d}`),
    0,
  );
}

/**
 * PAED: five items, each recorded on the same "not at all (0) -> extremely (4)"
 * response scale. Items 1-3 are reverse-scored here, never by the rater —
 * hand-reversal at the bedside is the classic source of PAED error.
 */
export function paedTotal(items) {
  if (!items || typeof items !== 'object') throw new Error('PAED: expected five item responses');
  return PAED_ITEMS.reduce((sum, item) => {
    const raw = requireInt(items[item.id], 0, 4, `PAED ${item.id}`);
    return sum + (item.reverse ? 4 - raw : raw);
  }, 0);
}

/** FPS-R: six faces, returning the 0-10 metric value rather than the ordinal position. */
export function fpsrScore(faceIndex) {
  requireInt(faceIndex, 0, 5, 'FPS-R face index');
  return faceIndex * 2;
}

export function nrsScore(value) {
  return requireInt(value, 0, 10, 'NRS');
}

export function umssScore(value) {
  return requireInt(value, 0, 4, 'UMSS');
}

/** m-YPAS Short Form: mean of (item / item maximum) across four domains, x100. Range 22.92-100. */
export function mypasSfScore(domains) {
  if (!domains || typeof domains !== 'object') throw new Error('m-YPAS-SF: expected four domain scores');
  const total = MYPAS_DOMAINS.reduce(
    (sum, d) => sum + requireInt(domains[d.id], 1, d.max, `m-YPAS-SF ${d.id}`) / d.max,
    0,
  );
  return round2((total / MYPAS_DOMAINS.length) * 100);
}

/**
 * Which way a PACU timepoint points: pain, delirium, or neither clearly.
 *
 * Takes the PAED items as the form records them — raw 0-4 responses on the
 * "not at all ... extremely" scale, before the app reverses items 1-3 — so
 * `purposeful: 0` means the child's movements are not purposeful at all.
 *
 * The rule is the one the protocol states and nothing more: a total at or
 * above the cutoff with non-purposeful movement is delirium; the same total
 * with purposeful movement is pain, because purpose and eye contact override
 * the score; below the cutoff, distress is pain until shown otherwise. No new
 * threshold is invented here — paedEdCutoff is the only number involved.
 */
export function pacuPathway({ paedTotal: paed, purposeful, eyeContact }) {
  requireInt(paed, 0, 20, 'PAED total');
  const cutoff = params().thresholds.paedEdCutoff;

  if (paed < cutoff) {
    return {
      pathway: 'pain',
      message: `Below the emergence-delirium cutoff of ${cutoff}. Distress here is more likely to be pain — score it.`,
    };
  }
  if (purposeful === 0) {
    return {
      pathway: 'delirium',
      message: `PAED ${paed} with non-purposeful movement. Emergence delirium likely — calming and reassurance, not more opioid.`,
    };
  }
  if (purposeful == null) {
    return {
      pathway: 'indeterminate',
      message: `PAED ${paed} is at or above the cutoff, but the purposeful-movement item has not been scored.`,
    };
  }
  return {
    pathway: 'pain',
    message: `PAED ${paed} is elevated, but the movement is purposeful${eyeContact ? ' and the child makes eye contact' : ''} — treat as pain.`,
  };
}

const REBOUND_ANCHORS = {
  sensory_regression: 'the block wearing off',
  block_placement: 'the block going in',
};

/**
 * The rebound definition, written out for a label.
 *
 * The form used to carry this wording as literal text in two places, which
 * meant a change to windowHours or the cut-offs left the screen contradicting
 * the parameters it was supposed to be enforcing. Built from params instead,
 * so the label cannot drift.
 *
 * An anchor with no wording throws rather than producing a label with
 * "undefined" in the middle of it: a nurse reading nonsense criteria at 3 a.m.
 * is worse than a build that fails here.
 */
export function reboundCriteria(which = 'protocol') {
  const d = params().rebound[which];
  if (!d) throw new Error(`No rebound definition called ${which}`);
  const anchor = REBOUND_ANCHORS[d.anchor];
  if (!anchor) throw new Error(`No wording for rebound anchor: ${d.anchor}`);
  return `\u2264${d.fromAtMost} \u2192 \u2265${d.toAtLeast} within ${d.windowHours} h of ${anchor}`
    + (d.requireRescue ? ', with rescue' : '');
}

/** 'none' | 'mild' | 'moderate' | 'severe' on the common 0-10 metric. */
export function painBand(score) {
  requireInt(score, 0, 10, 'Pain score');
  const bands = params().painBands;
  for (const name of ['none', 'mild', 'moderate', 'severe']) {
    const [lo, hi] = bands[name];
    if (score >= lo && score <= hi) return name;
  }
  throw new Error(`Pain score ${score} falls outside the configured bands`);
}

export function isModerateToSevere(score) {
  return score >= params().thresholds.moderateToSevere;
}

export function bmi(weightKg, heightCm) {
  if (!(weightKg > 0) || !(heightCm > 0)) throw new Error('BMI: weight and height must be positive');
  return round2(weightKg / (heightCm / 100) ** 2);
}

/**
 * Local anaesthetic dose against the weight-adjusted ceiling.
 * The one place the app blocks rather than warns: an entry over the maximum is
 * far more often a decimal slip in the form than a real overdose.
 */
export function localAnaestheticDose({ agent, concentrationPct, volumeMl, weightKg, withEpinephrine = false, dateOfBirth, at }) {
  const cfg = params().localAnaesthetic;
  const spec = cfg.agents[agent];
  if (!spec) throw new Error(`Unknown local anaesthetic: ${agent}`);
  if (!(weightKg > 0)) throw new Error('Local anaesthetic dose requires a positive weight');
  if (!(concentrationPct > 0) || !(volumeMl > 0)) throw new Error('Concentration and volume must be positive');

  const mg = concentrationPct * 10 * volumeMl;
  const mgPerKg = mg / weightKg;

  let maxMgPerKg = (withEpinephrine && spec.maxMgPerKgWithEpi) ? spec.maxMgPerKgWithEpi : spec.maxMgPerKg;
  let infantReduced = false;
  if (dateOfBirth != null && at != null && ageMonths(dateOfBirth, at) <= cfg.infantReductionMaxMonths) {
    maxMgPerKg *= cfg.infantReductionFactor;
    infantReduced = true;
  }

  const fraction = mgPerKg / maxMgPerKg;
  let verdict = 'ok';
  if (fraction > 1) verdict = 'block';
  else if (fraction >= cfg.warnFractionOfMax) verdict = 'warn';

  return {
    agent, mg: round2(mg), mgPerKg: round2(mgPerKg),
    maxMgPerKg: round2(maxMgPerKg), pctOfMax: round1(fraction * 100),
    infantReduced, verdict,
    message: verdict === 'block'
      ? `${round2(mgPerKg)} mg/kg exceeds the maximum of ${round2(maxMgPerKg)} mg/kg${infantReduced ? ' (reduced 30% under 6 months)' : ''}. Check the concentration and volume.`
      : verdict === 'warn'
        ? `${round1(fraction * 100)}% of the maximum dose.`
        : null,
  };
}

const MME_ROUTE_MAP = {
  Morphine:       { IV: 'morphine_iv', Oral: 'morphine_po', Rectal: 'morphine_po', IM: 'morphine_iv', Subcutaneous: 'morphine_iv' },
  Fentanyl:       { IV: 'fentanyl_iv', IM: 'fentanyl_iv', Subcutaneous: 'fentanyl_iv' },
  Oxycodone:      { Oral: 'oxycodone_po' },
  Hydromorphone:  { IV: 'hydromorphone_iv', Oral: 'hydromorphone_po', IM: 'hydromorphone_iv', Subcutaneous: 'hydromorphone_iv' },
  Tramadol:       { Oral: 'tramadol_po', IV: 'tramadol_po' },
  Codeine:        { Oral: 'codeine_po' },
};

/** Resolve a logged drug + route to an MME factor key, or null for non-opioids. */
export function resolveMmeKey(drug, route) {
  const byRoute = MME_ROUTE_MAP[drug];
  if (!byRoute) return null;
  return byRoute[route] ?? null;
}

/** Oral morphine milligram equivalents for one administered dose. Non-opioids return 0. */
export function doseMme({ drug, route, amount, unit }) {
  const key = resolveMmeKey(drug, route);
  if (!key) return 0;
  const factors = params().opioids.mme.factors;
  const spec = factors[key];
  if (!spec) throw new Error(`No MME factor configured for ${key}`);
  if (unit !== spec.unit) {
    throw new Error(`${drug} ${route} is converted from ${spec.unit}, but the dose was recorded in ${unit}`);
  }
  if (!(amount >= 0)) throw new Error('Dose amount must be non-negative');
  return round3(amount * spec.factor);
}

/** Intraoperative opioid load in mcg fentanyl equivalents. */
export function fentanylEquivalents(doses) {
  const factors = params().opioids.fentanylEquivalents.factors;
  return round2((doses || []).reduce((sum, d) => {
    const spec = factors[String(d.drug || '').toLowerCase()];
    if (!spec) throw new Error(`No fentanyl-equivalent factor for ${d.drug}`);
    if (d.unit !== spec.unit) throw new Error(`${d.drug} is converted from ${spec.unit}, got ${d.unit}`);
    return sum + d.amount * spec.factor;
  }, 0));
}

/**
 * PACU adjudication. Advisory only: the proposal and the nurse's decision are
 * stored in separate columns so algorithm-clinician agreement is reportable.
 */
export function pacuClassification({ paedTotal: paed, flaccTotal: flacc, gates }) {
  const t = params().thresholds;
  requireInt(paed, 0, 20, 'PAED total');
  requireInt(flacc, 0, 10, 'FLACC total');
  const g = gates || {};
  const over = paed >= t.paedEdCutoff;
  const purposefulAndPresent = g.eye_contact === true && g.purposeful === true;

  let classification, rationale;
  if (!over && purposefulAndPresent) {
    classification = 'Nociception';
    rationale = `PAED ${paed} below the cutoff of ${t.paedEdCutoff}, with eye contact and purposeful movement.`;
  } else if (over && g.eye_contact === false && g.purposeful === false && g.consolable === false) {
    classification = 'Emergence delirium';
    rationale = `PAED ${paed} at or above ${t.paedEdCutoff}, with no eye contact, non-purposeful movement and inconsolable.`;
  } else if (over && purposefulAndPresent) {
    classification = 'Nociception';
    rationale = `PAED ${paed} is elevated, but eye contact and purposeful movement override the score.`;
  } else {
    classification = 'Indeterminate';
    rationale = `PAED ${paed} with discordant behavioural gates. Reassess in 10 minutes.`;
  }

  const prompt = classification === 'Nociception' && flacc >= t.flaccIntervene
    ? `FLACC ${flacc} at or above ${t.flaccIntervene} — analgesia per protocol.`
    : classification === 'Emergence delirium'
      ? 'Environmental calming. Withhold opioid escalation.'
      : null;

  return { classification, rationale, prompt, paedOverCutoff: over };
}

/** Respiratory depression triggers. Any one opens the adverse event form. */
export function respiratoryDepression({ respiratoryRate, spo2, naloxoneGiven = false, dateOfBirth, at }) {
  const cfg = params().respiratoryDepression;
  const years = ageYears(dateOfBirth, at);
  const band = cfg.respiratoryRateThresholds.find((b) => b.maxYears === null || years <= b.maxYears);
  const reasons = [];

  if (Number.isFinite(respiratoryRate) && respiratoryRate < band.minRatePerMin) {
    reasons.push(`Respiratory rate ${respiratoryRate}/min is below ${band.minRatePerMin}/min for ${band.label}.`);
  }
  if (Number.isFinite(spo2) && spo2 < cfg.spo2MinPercent) {
    reasons.push(`SpO2 ${spo2}% is below ${cfg.spo2MinPercent}%.`);
  }
  if (naloxoneGiven && cfg.naloxoneIsTrigger) {
    reasons.push('Naloxone administered.');
  }
  return { triggered: reasons.length > 0, reasons, threshold: band.minRatePerMin };
}

/**
 * Codeine and tramadol age restrictions (FDA 2017).
 * Never blocks — refusing to record what actually happened corrupts the
 * dataset. Flags for same-shift PI review.
 */
export function restrictedForAge({ drug, route, dateOfBirth, at, procedureCategory }) {
  const key = resolveMmeKey(drug, route);
  const cfg = params().restrictedDrugs[key];
  if (!cfg) return { restricted: false };

  const years = ageYears(dateOfBirth, at);
  if (years <= cfg.maxYearsContraindicated) {
    return { restricted: true, flagToQc: true, blocks: false,
      message: `${drug} is contraindicated under ${cfg.maxYearsContraindicated + 1} years (FDA 2017). Recorded and flagged for PI review.` };
  }
  if (procedureCategory && cfg.alsoContraindicatedAfter.includes(procedureCategory) && years <= cfg.postOpMaxYears) {
    return { restricted: true, flagToQc: true, blocks: false,
      message: `${drug} is contraindicated after ${procedureCategory.toLowerCase()} under ${cfg.postOpMaxYears + 1} years (FDA 2017). Recorded and flagged for PI review.` };
  }
  return { restricted: false };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
export { round1, round2, round3 };
