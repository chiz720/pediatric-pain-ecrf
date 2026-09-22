/**
 * Camp configuration — the only file that changes between camps.
 *
 * Everything a collector would otherwise have to type lives here instead, so
 * opening the link is the whole of setup. Edit this, push, done.
 */

export const CONFIG = {
  /** The deployed Apps Script web app. Ends in /exec. */
  endpointUrl: 'https://script.google.com/macros/s/AKfycbxbBbo1cK7n_X1dHdw9_FIwq569wXoZEmPn5PwhbQeWtd0WKE7t4q0B7w3ks1i8F_yW/exec',

  /**
   * A single shared camp key, baked in so nobody ever types one.
   *
   * Be clear about what this is: anyone who reads the page source can find it.
   * It is not protection against a determined person. What it does do is stop
   * the workbook accepting writes from anything that merely stumbles on the
   * endpoint URL — a crawler, a scanner, a forwarded link — which matters
   * because this workbook holds children's dates of birth. If the link ever
   * escapes the team, change this one line and rotate the key in the script.
   */
  campKey: 'CAMP-2026-KN',

  /**
   * The enrolling centres. The two-letter code is the middle of every study
   * number — PPP-CH-0031-1 — so it is fixed for the life of the study. A
   * collector taps their centre once and the app never asks again.
   */
  centres: [
    { code: 'CH', name: 'Chuka Hospital' },
    { code: 'ME', name: 'Meru Hospital' },
    { code: 'GU', name: 'Guardian Hospital' },
  ],

  campId: '2026-01',

  /**
   * Who is collecting. A collector taps their name once; it is remembered.
   * Keep it short — this is a list people scroll on a phone.
   */
  collectors: [
    'Dr Idris',
    'Dr Susan',
    'Dr Romeo',
    'Nurse — recovery 1',
    'Nurse — recovery 2',
    'Nurse — ward 1',
    'Nurse — ward 2',
    'Nurse — ward 3',
    'Research assistant 1',
    'Research assistant 2',
  ],
};
