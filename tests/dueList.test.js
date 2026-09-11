import './_setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { childSchedule, buildDueList, dueListSummary, STATUS } from '../lib/dueList.js';

const END = '2026-09-11T10:00:00Z';
const at = (h) => new Date(Date.parse(END) + h * 3600000).toISOString();

const child = {
  study_number: 'PPP-KN-0147-0',
  date_of_birth: '2020-03-01',
  anaesthesia_end: END,
  pacu_arrival: at(0.2),
  procedure_category: 'Inguinal hernia repair',
};

test('a timepoint is due from the start of its window, not from its due time', () => {
  const rows = childSchedule({ child, observations: [], now: at(3.75) });
  const t4 = rows.find((r) => r.timepoint === 'T4');
  assert.equal(t4.status, STATUS.DUE);       // window opens at 3.5 h
  assert.equal(t4.minutesUntilDue, 15);
});

test('a timepoint goes overdue once its window closes', () => {
  const rows = childSchedule({ child, observations: [], now: at(4.75) });
  assert.equal(rows.find((r) => r.timepoint === 'T4').status, STATUS.OVERDUE);
});

test('an overdue timepoint becomes missed once the next window has also closed', () => {
  const rows = childSchedule({ child, observations: [], now: at(6.75) });
  assert.equal(rows.find((r) => r.timepoint === 'T4').status, STATUS.MISSED);
  assert.equal(rows.find((r) => r.timepoint === 'T6').status, STATUS.OVERDUE);
});

test('a collected timepoint is done regardless of when it was collected', () => {
  const rows = childSchedule({
    child, observations: [{ timepoint: 'T4', assessed_at: at(5) }], now: at(6),
  });
  assert.equal(rows.find((r) => r.timepoint === 'T4').status, STATUS.DONE);
});

test('nothing is due before either anchor is recorded', () => {
  const rows = childSchedule({
    child: { ...child, anaesthesia_end: null, pacu_arrival: null }, observations: [], now: at(10),
  });
  assert.ok(rows.every((r) => r.status === STATUS.UPCOMING));
  assert.match(rows[1].reason, /anchor timestamp/);
});

test('T0 has no window of its own, but still decays once the child has moved on', () => {
  // Not due until the child reaches the PACU.
  assert.equal(childSchedule({ child, observations: [], now: at(0.1) })
    .find((r) => r.timepoint === 'T0').status, STATUS.UPCOMING);

  // Due on arrival, and not "late" while the child is still in recovery.
  assert.equal(childSchedule({ child, observations: [], now: at(0.25) })
    .find((r) => r.timepoint === 'T0').status, STATUS.DUE);
  assert.equal(childSchedule({ child, observations: [], now: at(0.6) })
    .find((r) => r.timepoint === 'T0').status, STATUS.DUE);

  // Missed once T0_5's window has also shut — a PACU arrival assessment cannot
  // be performed retrospectively on a child who has reached the ward.
  assert.equal(childSchedule({ child, observations: [], now: at(9) })
    .find((r) => r.timepoint === 'T0').status, STATUS.MISSED);
});

test('T0 follows PACU arrival, not the anaesthesia-end offset', () => {
  const rows = childSchedule({ child, observations: [], now: at(0.3) });
  const t0 = rows.find((r) => r.timepoint === 'T0');
  assert.equal(t0.dueAt, at(0.2));
});

// A child caught up to a given timepoint, so the next action is unambiguous.
const caughtUp = (studyNumber, hoursPostOp, throughTimepoints) => ({
  child: {
    ...child,
    study_number: studyNumber,
    anaesthesia_end: at(-hoursPostOp),
    pacu_arrival: at(-hoursPostOp + 0.2),
  },
  observations: throughTimepoints.map((tp) => ({ timepoint: tp, assessed_at: at(-hoursPostOp) })),
});

test('the due list shows one next action per child, most urgent first', () => {
  const a = caughtUp('PPP-KN-0001-X', 20, ['T0', 'T0_5', 'T1', 'T2', 'T4', 'T6', 'T8', 'T12']);
  const b = caughtUp('PPP-KN-0002-X', 3.9, ['T0', 'T0_5', 'T1', 'T2']);
  const c = caughtUp('PPP-KN-0003-X', 0.1, ['T0']);

  const items = buildDueList({
    roster: [a, b, c].map((x) => x.child),
    observationsByChild: Object.fromEntries([a, b, c].map((x) => [x.child.study_number, x.observations])),
    now: END,
  });

  assert.equal(items.length, 3);
  assert.equal(items[0].studyNumber, 'PPP-KN-0001-X');
  assert.equal(items[0].status, STATUS.OVERDUE);
  assert.equal(items[0].timepoint, 'T18');

  assert.equal(items[1].studyNumber, 'PPP-KN-0002-X');
  assert.equal(items[1].status, STATUS.DUE);
  assert.equal(items[1].timepoint, 'T4');

  assert.equal(items[2].studyNumber, 'PPP-KN-0003-X');
  assert.equal(items[2].status, STATUS.UPCOMING);
  assert.equal(items[2].timepoint, 'T0_5');
});

test('a child who has been missed for hours surfaces their oldest outstanding timepoint', () => {
  const rows = childSchedule({ child: { ...child, anaesthesia_end: at(-4), pacu_arrival: at(-3.8) }, observations: [], now: END });
  const outstanding = rows.filter((r) => r.status === STATUS.OVERDUE || r.status === STATUS.DUE);

  // Four hours post-op, T0 and T0_5 have both decayed; T2 is still chaseable.
  assert.equal(outstanding[0].timepoint, 'T2');
  assert.equal(rows.find((r) => r.timepoint === 'T0').status, STATUS.MISSED);
  assert.equal(rows.find((r) => r.timepoint === 'T0_5').status, STATUS.MISSED);
});

test('each row carries the age and the instrument the rater will need', () => {
  const items = buildDueList({ roster: [child], observationsByChild: {}, now: at(4) });
  assert.equal(items[0].tool, 'fps_r');
  assert.equal(items[0].ageLabel, '6 y 6 m');
  assert.equal(items[0].procedure, 'Inguinal hernia repair');
});

test('a child with cognitive impairment routes to revised FLACC in the due list', () => {
  const items = buildDueList({
    roster: [{ ...child, cognitive_impairment: true }], observationsByChild: {}, now: at(4),
  });
  assert.equal(items[0].tool, 'r_flacc');
});

test('progress is reported per child so a falling-behind record is visible', () => {
  const observations = ['T0', 'T0_5', 'T1', 'T2'].map((tp) => ({ timepoint: tp, assessed_at: at(1) }));
  const items = buildDueList({
    roster: [child], observationsByChild: { [child.study_number]: observations }, now: at(9),
  });
  assert.equal(items[0].completed, 4);
  assert.equal(items[0].total, 13);
  assert.ok(items[0].missedCount > 0);
});

test('the summary counts what the coordinator acts on', () => {
  const a = caughtUp('A', 20, ['T0', 'T0_5', 'T1', 'T2', 'T4', 'T6', 'T8', 'T12']);
  const b = caughtUp('B', 3.9, ['T0', 'T0_5', 'T1', 'T2']);
  const c = caughtUp('C', 0.1, ['T0']);

  const s = dueListSummary(buildDueList({
    roster: [a, b, c].map((x) => x.child),
    observationsByChild: Object.fromEntries([a, b, c].map((x) => [x.child.study_number, x.observations])),
    now: END,
  }));
  assert.equal(s.children, 3);
  assert.equal(s.overdue, 1);
  assert.equal(s.due, 1);
  assert.equal(s.upcoming, 1);
});
