/**
 * Age arithmetic.
 *
 * Routing uses COMPLETED CALENDAR AGE, never a fixed day count. A child is four
 * years old when their fourth birthday has passed — which falls at 1460 or 1461
 * days depending on whether a leap day intervened. Day counts are recorded as a
 * modelling covariate only.
 */

/** Accepts {day,month,year}, 'YYYY-MM-DD', or a Date. Returns a UTC-midnight Date. */
export function toDate(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  if (value && typeof value === 'object' && 'year' in value) {
    const { year, month, day } = value;
    assertCalendarDate(year, month, day);
    return new Date(Date.UTC(year, month - 1, day));
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!m) throw new Error(`Unparseable date: ${value}`);
    const [, y, mo, d] = m.map(Number);
    assertCalendarDate(y, mo, d);
    return new Date(Date.UTC(y, mo - 1, d));
  }
  throw new Error('Unparseable date');
}

function assertCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error('Date parts must be integers');
  }
  if (month < 1 || month > 12) throw new Error(`Month out of range: ${month}`);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`Not a real calendar date: ${year}-${month}-${day}`);
  }
}

const MS_PER_DAY = 86400000;

/** Whole days elapsed. Negative if `at` precedes `dob`. */
export function ageDays(dob, at) {
  return Math.floor((toDate(at) - toDate(dob)) / MS_PER_DAY);
}

/** Completed calendar months. */
export function ageMonths(dob, at) {
  const b = toDate(dob), a = toDate(at);
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  if (a.getUTCDate() < b.getUTCDate()) months -= 1;
  return months;
}

/** Completed calendar years — the value routing decisions are made on. */
export function ageYears(dob, at) {
  return Math.floor(ageMonths(dob, at) / 12);
}

/** "4 y 2 m", or "7 m" under a year, or "18 d" under a month. */
export function ageLabel(dob, at) {
  const days = ageDays(dob, at);
  if (days < 0) return 'not yet born';
  const months = ageMonths(dob, at);
  if (months < 1) return `${days} d`;
  if (months < 12) return `${months} m`;
  return `${Math.floor(months / 12)} y ${months % 12} m`;
}

export function isFuture(dob, at) {
  return toDate(dob) > toDate(at);
}
