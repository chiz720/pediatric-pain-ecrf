/**
 * Clock-time arithmetic for the theatre log.
 *
 * Times arrive as wall clock — 08:40, 23:55 — with no date attached, because
 * that is what the anaesthetic chart has on it and typing a date for every
 * case would be four extra taps per child. A case that starts at 23:40 and
 * ends at 00:25 is forty-five minutes, not minus 1395, so an end before a
 * start is read as the same case running past midnight.
 *
 * Nothing here guesses at a missing time. One absent end gives `null`, never
 * `0`: a zero-minute anaesthetic is a claim, and an unknown one is not.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const MINUTES_PER_DAY = 1440;

const blank = (v) => v == null || String(v).trim() === '';

/** Minutes since midnight. Throws on anything that is not a time of day. */
export function toMinutes(time) {
  const m = HHMM.exec(String(time ?? '').trim());
  if (!m) throw new Error(`Not a time of day: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Whole minutes from start to end, wrapping past midnight. null if either is missing. */
export function minutesBetween(start, end) {
  if (blank(start) || blank(end)) return null;
  const from = toMinutes(start);
  const to = toMinutes(end);
  return to >= from ? to - from : to + MINUTES_PER_DAY - from;
}

/** "45 min", "1 h 35 min", "2 h". */
export function durationLabel(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Does the operation sit inside the anaesthetic?
 *
 * It always should — knife after induction, skin closed before the child is
 * woken — so when it does not, a time was mistyped. Returns null rather than
 * false when any of the four is missing: a half-filled log has not failed the
 * check, it has not taken it.
 */
export function surgeryWithinAnaesthesia({ anaesStart, anaesEnd, surgStart, surgEnd }) {
  const span = minutesBetween(anaesStart, anaesEnd);
  const toStart = minutesBetween(anaesStart, surgStart);
  const toEnd = minutesBetween(anaesStart, surgEnd);
  if (span == null || toStart == null || toEnd == null) return null;
  return toStart <= toEnd && toEnd <= span;
}
