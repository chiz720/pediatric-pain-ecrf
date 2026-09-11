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

function loadEndpoint({ tokens = { 'RN-014': 'TOK-1' }, schemaVer = '1.0.0' } = {}) {
  const ss = new FakeSpreadsheet();
  const scriptProps = new Map([
    ['TOKENS', JSON.stringify(tokens)],
    ['SCHEMA_VER', schemaVer],
  ]);
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
  return { sandbox, ss, scriptProps, cache };
}

const post = (sandbox, body) =>
  JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const get = (sandbox, parameter) => JSON.parse(sandbox.doGet({ parameter }).text);

const envelope = (submissions, over = {}) => ({
  token: 'TOK-1', deviceId: 'dev-9f2c41', raterId: 'RN-014',
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

test("one collector's token cannot be used under another collector's name", () => {
  // Otherwise a shared token would silently pollute the inter-rater analysis.
  const { sandbox } = loadEndpoint({ tokens: { 'RN-014': 'TOK-1', 'RN-015': 'TOK-2' } });
  assert.equal(post(sandbox, envelope([obs('a')], { raterId: 'RN-015' })).ok, false);
  assert.equal(post(sandbox, envelope([obs('a')], { raterId: 'RN-014' })).ok, true);
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
  assert.equal(cell('rater_id'), 'RN-014');
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

/* ---------------- the promise that matters ---------------- */

test('the roster never returns a date of birth', () => {
  const { sandbox } = loadEndpoint();
  post(sandbox, envelope([{
    uuid: 'e1', form: '01_enrolment', studyNumber: 'PPP-KN-0147-0',
    clientTs: '2026-09-11T09:00:00Z',
    data: { study_number: 'PPP-KN-0147-0', date_of_birth: '2022-07-11', age_days: 1523, age_months: 50 },
  }]));

  const res = get(sandbox, { mode: 'roster', token: 'TOK-1' });
  assert.equal(res.ok, true);
  assert.equal(res.roster.length, 1);

  const child = res.roster[0];
  assert.equal(child.study_number, 'PPP-KN-0147-0');
  assert.equal(child.age_days, 1523);
  assert.equal(child.date_of_birth, undefined);
  assert.ok(!JSON.stringify(res).includes('2022-07-11'),
    'a date of birth reached the roster response');
});

test('the roster is refused without a token', () => {
  const { sandbox } = loadEndpoint();
  assert.equal(get(sandbox, { mode: 'roster' }).ok, false);
  assert.equal(get(sandbox, { mode: 'roster', token: 'nope' }).ok, false);
});

test('the roster gathers the anchors the due-list needs', () => {
  const { sandbox } = loadEndpoint();
  post(sandbox, envelope([
    { uuid: 'e1', form: '01_enrolment', studyNumber: 'PPP-KN-0147-0', clientTs: '2026-09-11T09:00:00Z',
      data: { study_number: 'PPP-KN-0147-0', date_of_birth: '2022-07-11' } },
    { uuid: 'p1', form: '02_preop', studyNumber: 'PPP-KN-0147-0', clientTs: '2026-09-11T09:10:00Z',
      data: { study_number: 'PPP-KN-0147-0', weight_kg: 16, cognitive_impairment: false, procedure_category: 'Inguinal hernia repair' } },
    { uuid: 'i1', form: '03_intraop', studyNumber: 'PPP-KN-0147-0', clientTs: '2026-09-11T11:00:00Z',
      data: { study_number: 'PPP-KN-0147-0', anaesthesia_end: '2026-09-11T10:55:00Z', block_at: '2026-09-11T10:05:00Z' } },
  ]));

  const child = get(sandbox, { mode: 'roster', token: 'TOK-1' }).roster[0];
  assert.equal(child.anaesthesia_end, '2026-09-11T10:55:00Z');
  assert.equal(child.block_at, '2026-09-11T10:05:00Z');
  assert.equal(child.weight_kg, 16);
  assert.equal(child.procedure_category, 'Inguinal hernia repair');
});

test('health reports the schema version a tablet must match', () => {
  const { sandbox } = loadEndpoint();
  const res = get(sandbox, { mode: 'health' });
  assert.equal(res.ok, true);
  assert.equal(res.schemaVersion, '1.0.0');
  assert.ok(res.serverTs);
});

/* ---------------- setup ---------------- */

test('setup issues one token per collector and publishes them to _raters', () => {
  const { sandbox, ss, scriptProps } = loadEndpoint({ tokens: {} });
  sandbox.setup();

  const tokens = JSON.parse(scriptProps.get('TOKENS'));
  const n = sandbox.RATER_IDS.length;
  assert.equal(Object.keys(tokens).length, n);
  assert.equal(new Set(Object.values(tokens)).size, n, 'tokens must be distinct');

  const raters = ss.getSheetByName('_raters');
  assert.equal(raters.rows[0][0], 'rater_id');
  assert.equal(raters.rows.length, n + 1);
});

test('adding a collector mid-camp does not disturb anyone already working', () => {
  const { sandbox, scriptProps } = loadEndpoint({ tokens: { 'RN-01': 'KEEP-ME' } });
  sandbox.setup();
  const tokens = JSON.parse(scriptProps.get('TOKENS'));
  assert.equal(tokens['RN-01'], 'KEEP-ME');
  assert.equal(Object.keys(tokens).length, sandbox.RATER_IDS.length);
});

test('rotating a token revokes the old one immediately', () => {
  const { sandbox, scriptProps } = loadEndpoint({ tokens: { 'RN-014': 'OLD' } });
  sandbox.rotateToken('RN-014');
  const tokens = JSON.parse(scriptProps.get('TOKENS'));
  assert.notEqual(tokens['RN-014'], 'OLD');
  assert.equal(post(sandbox, envelope([obs('a')], { token: 'OLD' })).ok, false);
});

test('generated tokens omit characters that are misread when typed by hand', () => {
  const { sandbox, scriptProps } = loadEndpoint({ tokens: {} });
  sandbox.setup();
  for (const token of Object.values(JSON.parse(scriptProps.get('TOKENS')))) {
    assert.ok(!/[IO01]/.test(token), `${token} contains an ambiguous character`);
  }
});
