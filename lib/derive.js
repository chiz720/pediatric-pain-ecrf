/**
 * Cross-record derivations.
 *
 * These run over collections of rows rather than a single form, and are the
 * study's actual endpoints. The client computes them for display; the server
 * recomputes them from raw inputs and stores both, so a disagreement is a
 * signal that a tablet is running stale code.
 */

import { params } from './params.js';
import { doseMme, round2, round3 } from './scoring.js';

const MS_PER_HOUR = 3600000;
const ts = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
const hoursBetween = (from, to) => (ts(to) - ts(from)) / MS_PER_HOUR;

/** Whether an assessment landed inside its protocol window. */
export function onTimeFlag({ timepointId, actualAt, anaesthesiaEnd, pacuArrival }) {
  const sched = params().assessmentSchedule;
  const tp = sched.timepoints.find((t) => t.id === timepointId);
  if (!tp) {
    return timepointId === sched.unscheduledId
      ? { applicable: false, onTime: null, reason: 'Unscheduled assessment' }
      : { applicable: false, onTime: null, reason: `Unknown timepoint ${timepointId}` };
  }
  if (tp.windowMinutes == null) {
    return { applicable: false, onTime: true, reason: 'Event-anchored, no window' };
  }
  const anchor = tp.anchor === 'pacu_arrival' ? pacuArrival : anaesthesiaEnd;
  if (anchor == null) return { applicable: false, onTime: null, reason: 'Anchor timestamp missing' };

  const dueAt = ts(anchor) + tp.offsetHours * MS_PER_HOUR;
  const driftMinutes = (ts(actualAt) - dueAt) / 60000;
  return {
    applicable: true,
    onTime: Math.abs(driftMinutes) <= tp.windowMinutes,
    driftMinutes: Math.round(driftMinutes),
    windowMinutes: tp.windowMinutes,
    dueAt: new Date(dueAt).toISOString(),
  };
}

/** Cumulative oral morphine equivalents per kg within a window of anaesthesia end. */
export function cumulativeMmePerKg({ doses, weightKg, anaesthesiaEnd, windowHours }) {
  if (!(weightKg > 0)) throw new Error('cumulativeMmePerKg requires a positive weight');
  const total = (doses || [])
    .filter((d) => {
      const h = hoursBetween(anaesthesiaEnd, d.given_at);
      return h >= 0 && h <= windowHours;
    })
    .reduce((sum, d) => sum + doseMme({ drug: d.drug, route: d.route, amount: d.dose_amount, unit: d.dose_unit }), 0);
  return round3(total / weightKg);
}

/** Hours from anaesthesia end to the first PRN rescue dose. Censored if never. */
export function timeToFirstRescue({ doses, anaesthesiaEnd, censorHours = 48, ivOnly = false }) {
  const rescues = (doses || [])
    .filter((d) => d.indication === 'PRN rescue')
    .filter((d) => (ivOnly ? d.route === 'IV' : true))
    .map((d) => hoursBetween(anaesthesiaEnd, d.given_at))
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);

  if (rescues.length === 0) return { hours: censorHours, censored: true };
  return { hours: round2(rescues[0]), censored: false };
}

/**
 * Trapezoidal area under the pain-time curve, normalised to a mean score.
 * Flagged when observed coverage falls below the protocol floor, because an
 * AUC computed from four of thirteen timepoints is not the same quantity.
 */
export function painAuc({ observations, anaesthesiaEnd, windowHours, field = 'pain_rest' }) {
  const pts = (observations || [])
    .filter((o) => o[field] != null)
    .map((o) => ({ h: hoursBetween(anaesthesiaEnd, o.assessed_at), v: o[field] }))
    .filter((o) => o.h >= 0 && o.h <= windowHours)
    .sort((a, b) => a.h - b.h);

  const scheduled = params().assessmentSchedule.timepoints
    .filter((t) => t.offsetHours <= windowHours && t.rest).length;
  const coverage = scheduled > 0 ? pts.length / scheduled : 0;
  const sufficient = coverage >= params().assessmentSchedule.completenessFloor;

  if (pts.length < 2) {
    return { auc: null, meanScore: null, n: pts.length, coverage: round2(coverage), sufficient: false };
  }

  let area = 0;
  for (let i = 1; i < pts.length; i += 1) {
    area += ((pts[i].v + pts[i - 1].v) / 2) * (pts[i].h - pts[i - 1].h);
  }
  const span = pts[pts.length - 1].h - pts[0].h;
  return {
    auc: round2(area),
    meanScore: span > 0 ? round2(area / span) : round2(pts[0].v),
    n: pts.length,
    observedHours: round2(span),
    coverage: round2(coverage),
    sufficient,
  };
}

/**
 * Rebound pain, both definitions, from the same rows.
 * `protocol` is anchored to documented sensory regression; `barry` to block
 * placement, for comparability with the published literature.
 */
export function reboundPain({ definition = 'protocol', painBefore, painAfterSeries, rescueRequested, anchorAt, observations }) {
  const cfg = params().rebound[definition];
  if (!cfg) throw new Error(`Unknown rebound definition: ${definition}`);

  const wellControlled = painBefore != null && painBefore <= cfg.fromAtMost;

  const series = painAfterSeries
    ?? (observations || [])
      .filter((o) => o.pain_rest != null)
      .map((o) => ({ h: hoursBetween(anchorAt, o.assessed_at), v: o.pain_rest }))
      .filter((o) => o.h >= 0 && o.h <= cfg.windowHours)
      .map((o) => o.v);

  const peak = series && series.length ? Math.max(...series) : null;
  const escalated = peak != null && peak >= cfg.toAtLeast;
  const rescueOk = cfg.requireRescue ? rescueRequested === true : true;

  return {
    definition,
    rebound: Boolean(wellControlled && escalated && rescueOk),
    wellControlledBefore: wellControlled,
    peakAfter: peak,
    escalation: peak != null && painBefore != null ? peak - painBefore : null,
    windowHours: cfg.windowHours,
    anchor: cfg.anchor,
    requiredRescue: cfg.requireRescue,
    rescueRequested: rescueRequested ?? null,
  };
}

/** The supervised learning target. */
export function breakthroughPain24h({ observations, doses, anaesthesiaEnd, ivOnly = false }) {
  const cfg = params().breakthroughPain;
  const inWindow = (t) => {
    const h = hoursBetween(anaesthesiaEnd, t);
    return h >= 0 && h <= cfg.windowHours;
  };

  const painHits = (observations || []).filter(
    (o) => inWindow(o.assessed_at)
      && ((o.pain_rest != null && o.pain_rest >= cfg.scoreThreshold)
        || (o.pain_dynamic != null && o.pain_dynamic >= cfg.scoreThreshold)),
  );
  const rescueHits = (doses || []).filter(
    (d) => d.indication === 'PRN rescue' && inWindow(d.given_at) && (ivOnly ? d.route === 'IV' : true),
  );

  return {
    outcome: painHits.length > 0 || rescueHits.length > 0 ? 1 : 0,
    byPain: painHits.length > 0,
    byRescue: rescueHits.length > 0,
    peakPain: painHits.length
      ? Math.max(...painHits.flatMap((o) => [o.pain_rest, o.pain_dynamic].filter((v) => v != null)))
      : null,
    windowHours: cfg.windowHours,
    threshold: cfg.scoreThreshold,
    ivOnly,
  };
}

export function blockDurationHours({ blockAt, sensoryReturnAt }) {
  if (blockAt == null || sensoryReturnAt == null) return null;
  const h = hoursBetween(blockAt, sensoryReturnAt);
  return h >= 0 ? round2(h) : null;
}

/** Per-child completeness against the schedule, for the QC dashboard. */
export function completeness({ observations, anaesthesiaEnd, pacuArrival }) {
  const sched = params().assessmentSchedule;
  const seen = new Set((observations || []).map((o) => o.timepoint));
  const rows = sched.timepoints.map((tp) => {
    const obs = (observations || []).find((o) => o.timepoint === tp.id);
    const timing = obs
      ? onTimeFlag({ timepointId: tp.id, actualAt: obs.assessed_at, anaesthesiaEnd, pacuArrival })
      : null;
    return { id: tp.id, label: tp.label, present: seen.has(tp.id), onTime: timing ? timing.onTime : null };
  });
  const present = rows.filter((r) => r.present).length;
  const onTime = rows.filter((r) => r.onTime === true).length;
  return {
    rows,
    present,
    expected: rows.length,
    proportion: round2(present / rows.length),
    onTimeProportion: present > 0 ? round2(onTime / present) : 0,
    meetsFloor: present / rows.length >= sched.completenessFloor,
  };
}
