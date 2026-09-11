/**
 * The ward tablet's home screen.
 *
 * Every child runs on their own clock, anchored to their anaesthesia end, so
 * the due-list is computed rather than stored. This is the highest-value part
 * of the app for completeness: the 12-to-24 hour window is when data is most
 * often lost and most scientifically valuable.
 */

import { params } from './params.js';
import { ageLabel } from './age.js';
import { selectInstrument } from './routing.js';

export const STATUS = {
  DONE: 'done',
  OVERDUE: 'overdue',
  DUE: 'due',
  UPCOMING: 'upcoming',
  MISSED: 'missed',
};

const MS_PER_MIN = 60000;
const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * One child's schedule, resolved against what has already been collected.
 *
 * A timepoint is DUE from the start of its window; OVERDUE once the window has
 * closed; MISSED once the next timepoint's window has also closed, at which
 * point chasing it is no longer useful and it should stop competing for
 * attention with live work.
 */
export function childSchedule({ child, observations, now }) {
  const sched = params().assessmentSchedule;
  const t = ms(now);
  const anchorEnd = child.anaesthesia_end ? ms(child.anaesthesia_end) : null;
  const anchorPacu = child.pacu_arrival ? ms(child.pacu_arrival) : null;
  const done = new Map((observations || []).map((o) => [o.timepoint, o]));

  const rows = sched.timepoints.map((tp, index) => {
    const anchor = tp.anchor === 'pacu_arrival' ? anchorPacu : anchorEnd;
    const observation = done.get(tp.id) || null;

    if (observation) {
      return { ...base(tp, child), status: STATUS.DONE, dueAt: null, observation };
    }
    if (anchor == null) {
      return { ...base(tp, child), status: STATUS.UPCOMING, dueAt: null, reason: 'anchor timestamp not yet recorded' };
    }

    const dueAt = anchor + tp.offsetHours * 3600000;

    // An event-anchored timepoint (T0, at PACU arrival) has no window of its
    // own, so it is never merely "late" — but it does still decay. A PACU
    // arrival assessment cannot be performed on a child who reached the ward
    // hours ago, so it drops to missed on the same boundary as everything
    // else: once the following timepoint's window has closed too.
    if (tp.windowMinutes == null) {
      const status = t < dueAt
        ? STATUS.UPCOMING
        : (t > nextWindowClose(sched, index, anchor, dueAt) ? STATUS.MISSED : STATUS.DUE);
      return {
        ...base(tp, child),
        status,
        dueAt: new Date(dueAt).toISOString(),
        minutesUntilDue: Math.round((dueAt - t) / MS_PER_MIN),
        observation: null,
      };
    }

    const window = tp.windowMinutes * MS_PER_MIN;
    const opens = dueAt - window;
    const closes = dueAt + window;

    let status;
    if (t < opens) status = STATUS.UPCOMING;
    else if (t <= closes) status = STATUS.DUE;
    else {
      status = t > nextWindowClose(sched, index, anchor, closes) ? STATUS.MISSED : STATUS.OVERDUE;
    }

    return {
      ...base(tp, child),
      status,
      dueAt: new Date(dueAt).toISOString(),
      minutesUntilDue: Math.round((dueAt - t) / MS_PER_MIN),
      observation: null,
    };
  });

  return rows;
}

/** When the following timepoint's window shuts — the point past which chasing this one stops being useful. */
function nextWindowClose(sched, index, anchor, fallback) {
  const next = sched.timepoints[index + 1];
  if (!next) return fallback;
  return anchor + next.offsetHours * 3600000 + (next.windowMinutes ?? 0) * MS_PER_MIN;
}

function base(tp, child) {
  return {
    studyNumber: child.study_number,
    timepoint: tp.id,
    label: tp.label,
    rest: tp.rest,
    dynamic: tp.dynamic,
  };
}

const PRIORITY = {
  [STATUS.OVERDUE]: 0,
  [STATUS.DUE]: 1,
  [STATUS.UPCOMING]: 2,
  [STATUS.MISSED]: 3,
  [STATUS.DONE]: 4,
};

/**
 * The flattened, sorted list the home screen renders: the single next action
 * per child, most urgent first. Showing every pending timepoint for every child
 * would bury the one that actually needs doing now.
 */
export function buildDueList({ roster, observationsByChild, now }) {
  const items = [];

  for (const child of roster || []) {
    const observations = (observationsByChild && observationsByChild[child.study_number]) || [];
    const rows = childSchedule({ child, observations, now });
    const actionable = rows.filter((r) => r.status === STATUS.OVERDUE || r.status === STATUS.DUE);
    const next = actionable.length
      ? actionable[0]
      : rows.find((r) => r.status === STATUS.UPCOMING) || null;
    if (!next) continue;

    const instrument = child.date_of_birth
      ? selectInstrument({
          dateOfBirth: child.date_of_birth,
          assessedAt: now,
          cognitiveImpairment: child.cognitive_impairment,
        })
      : null;

    items.push({
      ...next,
      ageLabel: child.date_of_birth ? ageLabel(child.date_of_birth, now) : null,
      tool: instrument ? instrument.tool : null,
      procedure: child.procedure_category || null,
      overdueCount: rows.filter((r) => r.status === STATUS.OVERDUE).length,
      missedCount: rows.filter((r) => r.status === STATUS.MISSED).length,
      completed: rows.filter((r) => r.status === STATUS.DONE).length,
      total: rows.length,
    });
  }

  items.sort((a, b) => {
    const p = PRIORITY[a.status] - PRIORITY[b.status];
    if (p !== 0) return p;
    if (a.dueAt && b.dueAt) return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    return String(a.studyNumber).localeCompare(String(b.studyNumber));
  });

  return items;
}

/** Header counts, so the coordinator can see the camp at a glance. */
export function dueListSummary(items) {
  return {
    overdue: items.filter((i) => i.status === STATUS.OVERDUE).length,
    due: items.filter((i) => i.status === STATUS.DUE).length,
    upcoming: items.filter((i) => i.status === STATUS.UPCOMING).length,
    missedTotal: items.reduce((n, i) => n + i.missedCount, 0),
    children: items.length,
  };
}
