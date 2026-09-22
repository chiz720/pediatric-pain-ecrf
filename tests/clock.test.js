import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinutes, minutesBetween, durationLabel, surgeryWithinAnaesthesia,
} from '../lib/clock.js';

test('a duration is the minutes between two wall-clock times', () => {
  assert.equal(minutesBetween('08:40', '09:55'), 75);
  assert.equal(minutesBetween('08:00', '08:01'), 1);
});

test('a case running past midnight is not a negative duration', () => {
  // The night list is when this bites: 23:40 to 00:25 is forty-five minutes,
  // and a minus sign here would land in the analysis as a negative theatre time.
  assert.equal(minutesBetween('23:40', '00:25'), 45);
  assert.equal(minutesBetween('23:59', '00:00'), 1);
});

test('identical times are zero minutes, a missing time is not', () => {
  // Zero is a claim — the knife never went in. Null is the absence of one.
  assert.equal(minutesBetween('10:00', '10:00'), 0);
  assert.equal(minutesBetween('10:00', ''), null);
  assert.equal(minutesBetween('', '10:00'), null);
  assert.equal(minutesBetween(null, undefined), null);
});

test('anything that is not a time of day is refused, never coerced', () => {
  assert.throws(() => toMinutes('25:00'), /Not a time of day/);
  assert.throws(() => toMinutes('9:5'), /Not a time of day/);
  assert.throws(() => toMinutes('half past eight'), /Not a time of day/);
  assert.throws(() => minutesBetween('08:00', '8pm'), /Not a time of day/);
});

test('durations read the way a person would say them', () => {
  assert.equal(durationLabel(45), '45 min');
  assert.equal(durationLabel(60), '1 h');
  assert.equal(durationLabel(95), '1 h 35 min');
  assert.equal(durationLabel(0), '0 min');
  assert.equal(durationLabel(null), '—');
});

test('surgery outside the anaesthetic is a mistyped time, and is caught', () => {
  const ok = { anaesStart: '08:30', anaesEnd: '10:05', surgStart: '08:50', surgEnd: '09:45' };
  assert.equal(surgeryWithinAnaesthesia(ok), true);

  // Knife before induction.
  assert.equal(surgeryWithinAnaesthesia({ ...ok, surgStart: '08:10' }), false);
  // Still operating after the child is woken.
  assert.equal(surgeryWithinAnaesthesia({ ...ok, surgEnd: '10:30' }), false);
  // Closed before it started.
  assert.equal(surgeryWithinAnaesthesia({ ...ok, surgStart: '09:50', surgEnd: '09:45' }), false);

  // The edges are legitimate: knife at induction, closure as the gas goes off.
  assert.equal(surgeryWithinAnaesthesia({ ...ok, surgStart: '08:30', surgEnd: '10:05' }), true);
});

test('a half-filled theatre log has not failed the check, it has not taken it', () => {
  const partial = { anaesStart: '08:30', anaesEnd: '', surgStart: '08:50', surgEnd: '09:45' };
  assert.equal(surgeryWithinAnaesthesia(partial), null);
  assert.equal(surgeryWithinAnaesthesia({}), null);
});

test('midnight wrapping holds for the containment check too', () => {
  const overnight = { anaesStart: '23:30', anaesEnd: '01:10', surgStart: '23:50', surgEnd: '00:40' };
  assert.equal(surgeryWithinAnaesthesia(overnight), true);
  assert.equal(minutesBetween(overnight.anaesStart, overnight.anaesEnd), 100);
  assert.equal(minutesBetween(overnight.surgStart, overnight.surgEnd), 50);
});
