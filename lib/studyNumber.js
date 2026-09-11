/**
 * Study number: PPP-<site>-<sequence>-<check>
 *
 * The trailing check character is what stops a misread wristband or a
 * transposed digit from silently creating a phantom patient. Computed over the
 * site letters (A=01..Z=26) concatenated with the 4-digit sequence, using a
 * weighted mod-11; a remainder of 10 is written as 'X'.
 */

const FORMAT = /^PPP-([A-Z]{2})-(\d{4})-([0-9X])$/;

export function checkCharacter(siteCode, sequence) {
  if (!/^[A-Z]{2}$/.test(siteCode)) throw new Error(`Bad site code: ${siteCode}`);
  const seq = String(sequence).padStart(4, '0');
  if (!/^\d{4}$/.test(seq)) throw new Error(`Bad sequence: ${sequence}`);

  const digits = siteCode
    .split('')
    .map((ch) => String(ch.charCodeAt(0) - 64).padStart(2, '0'))
    .join('') + seq;

  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    sum += Number(digits[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const remainder = (11 - (sum % 11)) % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

export function format(siteCode, sequence) {
  const seq = String(sequence).padStart(4, '0');
  return `PPP-${siteCode}-${seq}-${checkCharacter(siteCode, seq)}`;
}

export function parse(studyNumber) {
  const m = FORMAT.exec(String(studyNumber || '').trim().toUpperCase());
  if (!m) return null;
  return { siteCode: m[1], sequence: m[2], check: m[3] };
}

/** { valid, reason } — the only function the enrolment form calls. */
export function validate(studyNumber) {
  const parsed = parse(studyNumber);
  if (!parsed) {
    return { valid: false, reason: 'format', message: 'Expected the form PPP-KN-0147-0.' };
  }
  const expected = checkCharacter(parsed.siteCode, parsed.sequence);
  if (expected !== parsed.check) {
    return { valid: false, reason: 'check_character', message: 'Check character does not match — re-scan or re-type the study number.' };
  }
  return { valid: true, ...parsed };
}
