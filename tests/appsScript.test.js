/**
 * The endpoint, exercised against in-memory stand-ins for the Google services.
 *
 * Code.gs cannot be imported — it is a plain script expecting Apps Script
 * globals — so it is loaded into a sandbox with fakes for SpreadsheetApp,
 * PropertiesService, CacheService, LockService and ContentService. That is
 * enough to verify the parts that decide what the workbook actually contains:
 * provenance stamping, header self-healing, deduplication, and the promise
 * that no date of birth ever leaves via the roster.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- fake Google services ---------------- */

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.frozen = 0; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.length ? Math.max(...this.rows.map((r) => r.length)) : 0; }
  setFrozenRows(n) { this.frozen = n; }
  appendRow(row) { this.rows.push(row.slice()); }
  clear() { this.rows = []; }
  getRange(r, c, nR = 1, nC = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nR; i += 1) {
          const row = sheet.rows[r - 1 + i] || [];
          out.push(Array.from({ length: nC }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j])));
        }
        return out;
      },
      setValues(values) {
        values.forEach((row, i) => {
          const idx = r - 1 + i;
          if (!sheet.rows[idx]) sheet.rows[idx] = [];
          row.forEach((v, j) => { sheet.rows[idx][c - 1 + j] = v; });
        });
      },
      setFontWeight() { return this; },
    };
  }
  getDataRange() { return this.getRange(1, 1, this.rows.length, this.getLastColumn()); }
  autoResizeColumns() {}
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.set(n, s); return s; }
}

function loadEndpoint({ campKey = 'CAMP-2026-KN', schemaVer = '1.0.0' } = {}) {
  const ss = new FakeSpreadsheet();
  const scriptProps = new Map();
  const cache = new Map();

  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null),
        setProperty: (k, v) => scriptProps.set(k, v),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
    },
    Logger: { log() {} },
    JSON, Date, Math, Object, Array, String, Number, Error, isNaN,
  };
  createContext(sandbox);
  runInContext(readFileSync(join(root, 'apps-script/Code.gs'), 'utf8'), sandbox);
  sandbox.CAMP_KEY = campKey;
  sandbox.SCHEMA_VERSION = schemaVer;
  return { sandbox, ss, scriptProps, cache };
}

const post = (sandbox, body) =>
  JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (sandbox, parameter) => JSON.parse(sandbox.doGet({ parameter }).text);

const envelope = (submissions, over = {}) => ({
  token: 'CAMP-2026-KN', deviceId: 'dev-9f2c41', raterId: 'Nurse — ward 1',
  schemaVersion: '1.0.0', appVersion: '2026.09.11', paramsVersion: '1.0.0',
  submissions, ...over,
});

const obs = (uuid, data = {}) => ({
  uuid, form: '05_pain_obs', studyNumber: 'PPP-KN-0147-0', timepoint: 'T4',
  clientTs: '2026-09-11T10:00:00Z', training: false,
  data: { pain_rest: { score: 6, tool_used: 'fps_r' }, umss: 0, ...data },
});

/* ---------------- auth ---------------- */

test('a request without a valid token is refused', () => {
  const { sandbox } = loadEndpoint();
  const res = post(sandbox, envelope([obs('a')], { token: 'WRONG' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unauthorised');
});

test('the camp key is the only credential, and it is checked', () => {
  const { sandbox } = loadEndpoint();
  assert.equal(post(sandbox, envelope([obs('a')])).ok, true);
  assert.equal(post(sandbox, envelope([obs('b')], { token: 'CAMP-2025-OLD' })).ok, false);
});

test('changing the camp key locks out anyone still holding the old one', () => {
  // This is how a leaked link or a lost phone is dealt with: one line in
  // Code.gs and config.js, redeploy, and the old key stops working.
  const { sandbox } = loadEndpoint({ campKey: 'CAMP-2026-ROTATED' });
  assert.equal(post(sandbox, envelope([obs('a')])).ok, false);
  assert.equal(post(sandbox, envelope([obs('a')], { token: 'CAMP-2026-ROTATED' })).ok, true);
});

test('the collector name is recorded as given — it is attribution, not authentication', () => {
  const { sandbox, ss } = loadEndpoint();
  post(sandbox, envelope([obs('a')], { raterId: 'Dr Susan' }));
  const sheet = ss.getSheetByName('05_pain_obs');
  assert.equal(sheet.rows[1][sheet.rows[0].indexOf('rater_id')], 'Dr Susan');
});

/* ---------------- writing ---------------- */

test('a submission becomes a row with full provenance', () => {
  const { sandbox, ss } = loadEndpoint();
  const res = post(sandbox, envelope([obs('uuid-1')]));
  assert.deepEqual(res.accepted, ['uuid-1']);

  const sheet = ss.getSheetByName('05_pain_obs');
  const headers = sheet.rows[0];
  const row = sheet.rows[1];
  const cell = (name) => row[headers.indexOf(name)];

  assert.equal(cell('submission_uuid'), 'uuid-1');
  assert.equal(cell('study_number'), 'PPP-KN-0147-0');
  assert.equal(cell('rater_id'), 'Nurse — ward 1');
  assert.equal(cell('device_id'), 'dev-9f2c41');
  assert.equal(cell('timepoint'), 'T4');
  assert.equal(cell('client_ts'), '2026-09-11T10:00:00Z');
  assert.ok(cell('server_ts'));
  assert.equal(cell('training'), 0);
});

test('nested instrument payloads flatten into their own columns', () => {
  const { sandbox, ss } = loadEndpoint();
  post(sandbox, envelope([{
    uuid: 'u-flacc', form: '04_pacu_t0', studyNumber: 'PPP-KN-0147-0',
    clientTs: '2026-09-11T10:00:00Z',
    data: { flacc: { score: 4, components: { face: 1, legs: 0, activity: 1, cry: 2, consolability: 0 } } },
  }]));
  const sheet = ss.getSheetByName('04_pacu_t0');
  const headers = sheet.rows[0];
  assert.ok(headers.includes('flacc.score'));
  assert.ok(headers.includes('flacc.components.face'));
  assert.equal(sheet.rows[1][headers.indexOf('flacc.score')], 4);
  assert.equal(sheet.rows[1][headers.indexOf('flacc.components.cry')], 2);
});

test('a field the sheet has never seen appends a column instead of being dropped', () => {
  const { sandbox, ss } = loadEndpoint();
  post(sandbox, envelope([obs('u1')]));
  const before = ss.getSheetByName('05_pain_obs').rows[0].length;

  post(sandbox, envelope([obs('u2', { newly_added_field: 'kept' })]));
  const sheet = ss.getSheetByName('05_pain_obs');
  const headers = sheet.rows[0];

  assert.ok(headers.length > before);
  assert.ok(headers.includes('newly_added_field'));
  assert.equal(sheet.rows[2][headers.indexOf('newly_added_field')], 'kept');
  assert.equal(sheet.rows[1][headers.indexOf('submission_uuid')], 'u1');
});

test('multi-select arrays are stored as one readable cell', () => {
  const { sandbox, ss } = loadEndpoint();
  post(sandbox, envelope([obs('u1', { intervention: ['Environmental calming', 'Caregiver presence'] })]));
  const sheet = ss.getSheetByName('05_pain_obs');
  const headers = sheet.rows[0];
  assert.equal(sheet.rows[1][headers.indexOf('intervention')], 'Environmental calming; Caregiver presence');
});

/* ---------------- idempotency ---------------- */

test('re-sending a batch creates no second row', () => {
  const { sandbox, ss } = loadEndpoint();
  const batch = envelope([obs('same-uuid')]);

  const first = post(sandbox, batch);
  const second = post(sandbox, batch);

  assert.deepEqual(first.accepted, ['same-uuid']);
  assert.deepEqual(second.accepted, []);
  assert.deepEqual(second.duplicates, ['same-uuid']);
  assert.equal(ss.getSheetByName('05_pain_obs').rows.length, 2);
});

test('deduplication survives a cache eviction, because the column is scanned', () => {
  const { sandbox, ss, cache } = loadEndpoint();
  post(sandbox, envelope([obs('same-uuid')]));
  cache.clear();

  const again = post(sandbox, envelope([obs('same-uuid')]));
  assert.deepEqual(again.duplicates, ['same-uuid']);
  assert.equal(ss.getSheetByName('05_pain_obs').rows.length, 2);
});

test('a mismatched schema version is rejected per submission, not per batch', () => {
  const { sandbox } = loadEndpoint({ schemaVer: '2.0.0' });
  const res = post(sandbox, envelope([obs('a')]));
  assert.deepEqual(res.accepted, []);
  assert.equal(res.rejected[0].reason, 'schema_version_unsupported');
  assert.equal(res.ok, true);
});

test('one malformed submission does not sink the rest of the batch', () => {
  const { sandbox } = loadEndpoint();
  const res = post(sandbox, envelope([obs('good-1'), { uuid: 'bad', clientTs: 'x' }, obs('good-2')]));
  assert.deepEqual(res.accepted.sort(), ['good-1', 'good-2']);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].reason, 'malformed');
});

/* ---------------- audit ---------------- */

test('every request is logged with its sync latency', () => {
  const { sandbox, ss } = loadEndpoint();
  post(sandbox, envelope([obs('a'), obs('b')]));
  const audit = ss.getSheetByName('_audit');
  const headers = audit.rows[0];
  const row = audit.rows[1];
  assert.equal(row[headers.indexOf('n_submitted')], 2);
  assert.equal(row[headers.indexOf('n_accepted')], 2);
  assert.equal(row[headers.indexOf('device_id')], 'dev-9f2c41');
  assert.ok(row[headers.indexOf('max_latency_s')] > 0);
});

/* ---------------- surface area ---------------- */

/* ---------------- study number allocation ---------------- */

const baseline = (uuid, studyNumber, data = {}) => ({
  uuid, form: '01_baseline', studyNumber,
  clientTs: '2026-09-22T08:00:00Z', training: false,
  data: { centre: studyNumber.slice(4, 6), hospital_number: 'MRN-88213', age_months: 62, ...data },
});


const alloc = (sandbox, centre, requestId) =>
  post(sandbox, { token: 'CAMP-2026-KN', mode: 'allocate', centre, requestId });

test('the first child at a centre is 0001, and each centre counts alone', () => {
  const { sandbox } = loadEndpoint();
  assert.equal(alloc(sandbox, 'CH', 'r1').studyNumber, 'PPP-CH-0001');
  assert.equal(alloc(sandbox, 'CH', 'r2').studyNumber, 'PPP-CH-0002');
  assert.equal(alloc(sandbox, 'ME', 'r3').studyNumber, 'PPP-ME-0001');
  assert.equal(alloc(sandbox, 'GU', 'r4').studyNumber, 'PPP-GU-0001');
  assert.equal(alloc(sandbox, 'CH', 'r5').studyNumber, 'PPP-CH-0003');
});

test('two phones asking at the same moment never get the same number', () => {
  // Serialised by the script lock doPost already holds. Twenty requests in a
  // row stand in for twenty clinicians: every number is distinct and in order.
  const { sandbox } = loadEndpoint();
  const issued = [];
  for (let i = 1; i <= 20; i += 1) issued.push(alloc(sandbox, 'CH', `r${i}`).studyNumber);
  assert.equal(new Set(issued).size, 20);
  assert.equal(issued[0], 'PPP-CH-0001');
  assert.equal(issued[19], 'PPP-CH-0020');
});

test('a retried allocation returns the number already issued, it does not burn a second', () => {
  // A POST diverted to doGet is retried by the client. Without the requestId
  // memo the child would end up with two numbers and the first would be lost.
  const { sandbox } = loadEndpoint();
  const first = alloc(sandbox, 'CH', 'same-request');
  const retry = alloc(sandbox, 'CH', 'same-request');
  assert.equal(retry.studyNumber, first.studyNumber);
  assert.equal(retry.reissued, true);
  // And the counter did not move on.
  assert.equal(alloc(sandbox, 'CH', 'next').studyNumber, 'PPP-CH-0002');
});

test('allocation never reissues a number the workbook already holds', () => {
  // Script Properties are not the record — 01_baseline is. A cleared property
  // or a restored workbook must not hand out a number a child already wears.
  const { sandbox, scriptProps } = loadEndpoint();
  post(sandbox, envelope([baseline('u1', 'PPP-CH-0007')]));
  scriptProps.clear();
  assert.equal(alloc(sandbox, 'CH', 'r1').studyNumber, 'PPP-CH-0008');
});

test('allocation refuses a centre it cannot put in a study number', () => {
  const { sandbox } = loadEndpoint();
  assert.equal(alloc(sandbox, 'Chuka Hospital', 'r1').error, 'bad_centre');
  assert.equal(alloc(sandbox, '', 'r2').error, 'bad_centre');
  assert.equal(post(sandbox, { token: 'WRONG', mode: 'allocate', centre: 'CH' }).error, 'unauthorised');
});

test('the endpoint does three things: accept writes, report health, answer "is this serial used?"', () => {
  // No roster, no read-back of study data. The form is one document per child,
  // so nothing needs to fetch a list — and an endpoint that cannot read out
  // cannot leak on a GET. The enrolment check is the one exception and it
  // returns a boolean about a number the caller already holds.
  const { sandbox } = loadEndpoint();
  assert.equal(typeof sandbox.roster, 'undefined');
  assert.equal(typeof sandbox.cachedRoster, 'undefined');
  assert.equal(get(sandbox, { mode: 'roster', token: 'CAMP-2026-KN' }).error, 'unknown_mode');
  assert.equal(get(sandbox, { mode: 'anything', token: 'CAMP-2026-KN' }).error, 'unknown_mode');
  assert.deepEqual(
    Object.keys(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN', sn: 'PPP-CH-0031' })).sort(),
    ['enrolled', 'ok'],
  );
});

/* ---------------- three centres, one serial each ---------------- */


test('a serial already enrolled is reported as used, so two centres cannot share a child', () => {
  const { sandbox } = loadEndpoint();
  post(sandbox, envelope([baseline('u1', 'PPP-CH-0031')]));

  assert.equal(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN', sn: 'PPP-CH-0031' }).enrolled, true);
  // Same digits, different centre: a different child, and must not collide.
  assert.equal(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN', sn: 'PPP-ME-0031' }).enrolled, false);
  assert.equal(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN', sn: 'PPP-GU-0031' }).enrolled, false);
});

test('an unused serial, an unknown sheet and a missing number all answer false rather than erroring', () => {
  const { sandbox } = loadEndpoint();
  // Nothing written yet — the tab does not even exist.
  assert.equal(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN', sn: 'PPP-CH-0001' }).enrolled, false);
  assert.equal(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN' }).enrolled, false);
});

test('the enrolment check needs the camp key', () => {
  const { sandbox } = loadEndpoint();
  post(sandbox, envelope([baseline('u1', 'PPP-CH-0031')]));
  const res = get(sandbox, { mode: 'check', token: 'WRONG', sn: 'PPP-CH-0031' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unauthorised');
  assert.equal(res.enrolled, undefined);
});

test('the enrolment check never returns the hospital number sitting in the same row', () => {
  // The baseline tab is the one place a direct identifier lives. The check
  // reads its study_number column and returns a boolean — nothing else.
  const { sandbox } = loadEndpoint();
  post(sandbox, envelope([baseline('u1', 'PPP-CH-0031', { hospital_number: 'MRN-88213' })]));
  const body = JSON.stringify(get(sandbox, { mode: 'check', token: 'CAMP-2026-KN', sn: 'PPP-CH-0031' }));
  assert.ok(!body.includes('MRN-88213'), 'the hospital number leaked through the enrolment check');
  assert.ok(!body.includes('PPP-'), 'the enrolment check echoed a study number');
});

test('a GET cannot read back anything that was written', () => {
  const { sandbox } = loadEndpoint();
  post(sandbox, envelope([obs('a', { rest_pain: 7 })]));

  // Health says only what a client needs to decide whether it is up to date.
  const health = get(sandbox, { mode: 'health' });
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'schemaVersion', 'serverTs']);

  // Nothing a GET returns carries a subject id or a clinical value.
  for (const mode of ['health', 'roster', 'anything', undefined]) {
    const body = JSON.stringify(get(sandbox, { mode, token: 'CAMP-2026-KN' }));
    assert.ok(!body.includes('PPP-'), `${mode} leaked a subject id`);
    assert.ok(!body.includes('rest_pain'), `${mode} leaked a clinical field`);
  }
});

test('health reports the schema version a tablet must match', () => {
  const { sandbox } = loadEndpoint();
  const res = get(sandbox, { mode: 'health' });
  assert.equal(res.ok, true);
  assert.equal(res.schemaVersion, '1.0.0');
  assert.ok(res.serverTs);
});

/* ---------------- no setup step ---------------- */

test('the endpoint needs no configuration run before it works', () => {
  // No Script Properties, no setup(), no token sheet. Paste, deploy, done —
  // a step nobody can forget is a step nobody can get wrong.
  const { sandbox, ss } = loadEndpoint();
  assert.equal(typeof sandbox.setup, 'undefined');
  assert.equal(typeof sandbox.rotateToken, 'undefined');

  const res = post(sandbox, envelope([obs('first-ever')]));
  assert.deepEqual(res.accepted, ['first-ever']);
  assert.ok(ss.getSheetByName('05_pain_obs'), 'the sheet created itself on first write');
});
