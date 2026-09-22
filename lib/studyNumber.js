/**
 * Study number: PPP-<centre>-<sequence>
 *
 * The centre code is the middle — CH, ME, GU — and the four digits are a
 * counter that runs per centre from 0001. The endpoint hands them out one at a
 * time under a script lock, so two clinicians enrolling in the same second
 * cannot be given the same number, and PPP-CH-0001 really is the first child
 * enrolled at Chuka.
 *
 * There is no check character, because the number is generated at enrolment
 * rather than typed. Where it IS typed — the ward opening Module 4 off a paper
 * form hours later — the app checks it against the workbook instead, which
 * beats a checksum on the slip that actually happens: a number nobody enrolled
 * has no baseline row, and the app says so out loud. Neither test catches a
 * slip that lands on another enrolled child; only reading the name off the
 * form does that.
 */

const FORMAT = /^PPP-([A-Z]{2})-(\d{4})$/;

export const MAX_SEQUENCE = 9999;

export function format(centre, sequence) {
  if (!/^[A-Z]{2}$/.test(String(centre))) throw new Error(`Bad centre code: ${centre}`);
  const n = Number(sequence);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEQUENCE) {
    throw new Error(`Bad sequence: ${sequence}`);
  }
  return `PPP-${centre}-${String(n).padStart(4, '0')}`;
}

export function parse(studyNumber) {
  const m = FORMAT.exec(String(studyNumber || '').trim().toUpperCase());
  if (!m) return null;
  return { centre: m[1], sequence: m[2] };
}

/** { valid, reason } — the only function the form calls. */
export function validate(studyNumber) {
  const parsed = parse(studyNumber);
  if (!parsed) {
    return { valid: false, reason: 'format', message: 'Expected the form PPP-CH-0001.' };
  }
  if (parsed.sequence === '0000') {
    return { valid: false, reason: 'format', message: 'Numbering starts at 0001.' };
  }
  return { valid: true, ...parsed };
}
