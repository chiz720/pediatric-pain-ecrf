/**
 * PPP eCRF endpoint.
 *
 * One Apps Script project, bound to the workbook, deployed as a web app
 * executing as the study account.
 *
 * FIRST-TIME SETUP — do this once, before deploying:
 *   1. Run the setup() function from the editor (Run > setup).
 *   2. Approve the permissions prompt.
 *   3. Open the new _devices tab in the workbook to read the device tokens.
 *   4. Deploy > New deployment > Web app
 *        Execute as:      Me
 *        Who has access:  Anyone with the link
 *   5. Copy the /exec URL into each tablet's Settings screen.
 *
 * Contract notes:
 *   - Always returns HTTP 200. Outcomes are per-submission, so one bad row
 *     never fails a batch.
 *   - A duplicate is a success. This is what makes a flaky network safe.
 *   - Never returns date_of_birth. The roster carries derived age only.
 */

var SCHEMA_VERSION = '1.0.0';

/**
 * One token per data collector, not per device. Collectors open a shared link
 * on their own phone or laptop, so the device is unknown in advance — the
 * person is the thing you can actually issue a credential to and revoke.
 * Add or remove ids here and re-run setup().
 */
var RATER_IDS = [
  'RN-01', 'RN-02', 'RN-03', 'RN-04', 'RN-05', 'RN-06',
  'MO-01', 'MO-02', 'RA-01', 'RA-02', 'COORD-01',
];

/**
 * Run once from the editor. Issues one token per collector, stores them, and
 * writes them to a _raters tab so the coordinator can hand them out without
 * ever opening the script again.
 *
 * Safe to re-run: it keeps existing tokens and only fills in missing ones, so
 * adding a collector mid-camp does not disturb anyone already working.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var tokens = JSON.parse(props.getProperty('TOKENS') || '{}');

  RATER_IDS.forEach(function (id) {
    if (!tokens[id]) tokens[id] = newToken();
  });

  props.setProperty('TOKENS', JSON.stringify(tokens));
  props.setProperty('SCHEMA_VER', SCHEMA_VERSION);

  writeRaterSheet(tokens);
  Logger.log('Setup complete. ' + Object.keys(tokens).length + ' collector tokens are in the _raters tab.');
}

/**
 * Issue a fresh token for one collector, invalidating the old one at once.
 * Use this when someone leaves the camp or loses their phone.
 */
function rotateToken(raterId) {
  var props = PropertiesService.getScriptProperties();
  var tokens = JSON.parse(props.getProperty('TOKENS') || '{}');
  tokens[raterId] = newToken();
  props.setProperty('TOKENS', JSON.stringify(tokens));
  writeRaterSheet(tokens);
  Logger.log('New token for ' + raterId + ': ' + tokens[raterId]);
}

function newToken() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — these get typed by hand
  var out = '';
  for (var i = 0; i < 20; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i % 5 === 4 && i < 19) out += '-';
  }
  return out;
}

function writeRaterSheet(tokens) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('_raters');
  if (!sheet) sheet = ss.insertSheet('_raters');
  sheet.clear();
  sheet.appendRow(['rater_id', 'token', 'name', 'role', 'calibrated']);
  Object.keys(tokens).sort().forEach(function (id) {
    sheet.appendRow([id, tokens[id], '', '', '']);
  });
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  sheet.autoResizeColumns(1, 5);
}

var PROVENANCE = [
  'submission_uuid', 'supersedes_uuid', 'study_number', 'rater_id', 'device_id',
  'client_ts', 'server_ts', 'schema_version', 'app_version', 'params_version', 'training',
];

var NEVER_RETURN = ['date_of_birth'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    var auth = authorise(body);
    if (!auth.ok) return json({ ok: false, error: auth.error });

    if (!lock.tryLock(30000)) {
      return json({
        ok: true,
        serverTs: new Date().toISOString(),
        accepted: [], duplicates: [],
        rejected: (body.submissions || []).map(function (s) {
          return { uuid: s.uuid, reason: 'lock_timeout' };
        }),
      });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var serverTs = new Date().toISOString();
    var accepted = [], duplicates = [], rejected = [];
    var seen = seenIndex();

    (body.submissions || []).forEach(function (sub) {
      try {
        if (!sub.uuid || !sub.form) {
          rejected.push({ uuid: sub.uuid || null, reason: 'malformed' });
          return;
        }
        if (body.schemaVersion !== props('SCHEMA_VER')) {
          rejected.push({ uuid: sub.uuid, reason: 'schema_version_unsupported' });
          return;
        }
        // Cache first, then a column scan. The scan is what makes this correct
        // rather than merely fast: a cache eviction must not create a duplicate.
        if (isDuplicate(ss, sub.form, sub.uuid, seen)) {
          duplicates.push(sub.uuid);
          return;
        }
        writeRow(ss, sub, body, serverTs);
        markSeen(seen, sub.uuid);
        accepted.push(sub.uuid);
      } catch (err) {
        rejected.push({ uuid: sub.uuid, reason: String(err).slice(0, 200) });
      }
    });

    audit(ss, body, serverTs, accepted.length, duplicates.length, rejected.length, '');

    return json({
      ok: true,
      serverTs: serverTs,
      accepted: accepted,
      duplicates: duplicates,
      rejected: rejected,
      schemaVersion: props('SCHEMA_VER'),
    });
  } catch (err) {
    return json({ ok: false, error: 'server_error', detail: String(err).slice(0, 200) });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function doGet(e) {
  var mode = (e.parameter || {}).mode;
  if (mode === 'health') {
    return json({
      ok: true,
      serverTs: new Date().toISOString(),
      schemaVersion: props('SCHEMA_VER'),
    });
  }
  if (mode === 'roster') {
    if (!tokenValid(e.parameter.token)) return json({ ok: false, error: 'unauthorised' });
    return json({ ok: true, serverTs: new Date().toISOString(), roster: roster() });
  }
  // A POST diverted here by a cached redirect lands with no mode. Say so
  // explicitly rather than returning something a client could mistake for an
  // acknowledgement.
  return json({ ok: false, error: 'unknown_mode', hint: 'POST to /exec directly; do not reuse a cached redirect.' });
}

/* ------------------------------------------------------------------ */

function authorise(body) {
  if (!body || !body.token) return { ok: false, error: 'unauthorised' };
  if (!tokenValid(body.token, body.raterId)) return { ok: false, error: 'unauthorised' };
  return { ok: true };
}

/**
 * A token belongs to a collector. When a raterId is supplied the pair must
 * match, so one person's token cannot be used under another person's name and
 * quietly corrupt the inter-rater analysis.
 */
function tokenValid(token, raterId) {
  if (!token) return false;
  var tokens = JSON.parse(props('TOKENS') || '{}');
  if (raterId) return tokens[raterId] === token;
  for (var k in tokens) if (tokens[k] === token) return true;
  return false;
}

function props(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Self-healing headers: the first write to a tab creates the header row, and a
 * submission carrying a key the sheet has not seen appends a new column at the
 * right end rather than dropping the value.
 */
function writeRow(ss, sub, body, serverTs) {
  var sheet = ss.getSheetByName(sub.form) || ss.insertSheet(sub.form);
  var flat = flatten(sub.data || {});

  var provenance = {
    submission_uuid: sub.uuid,
    supersedes_uuid: sub.supersedes || '',
    study_number: sub.studyNumber || '',
    rater_id: body.raterId || '',
    device_id: body.deviceId || '',
    client_ts: sub.clientTs || '',
    server_ts: serverTs,
    schema_version: body.schemaVersion || '',
    app_version: body.appVersion || '',
    params_version: body.paramsVersion || '',
    training: sub.training === true ? 1 : 0,
  };
  if (sub.timepoint) provenance.timepoint = sub.timepoint;

  var headers = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    : [];

  if (headers.length === 0 || headers[0] === '') {
    headers = PROVENANCE.concat(['timepoint']).concat(Object.keys(flat).sort());
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else {
    var known = {};
    headers.forEach(function (h) { known[h] = true; });
    var added = Object.keys(flat).filter(function (k) { return !known[k]; }).sort();
    if (added.length) {
      sheet.getRange(1, headers.length + 1, 1, added.length).setValues([added]);
      headers = headers.concat(added);
    }
  }

  var all = {};
  for (var p in provenance) all[p] = provenance[p];
  for (var f in flat) all[f] = flat[f];

  var row = headers.map(function (h) {
    return all[h] === undefined || all[h] === null ? '' : all[h];
  });
  sheet.appendRow(row);
}

/** Nested instrument payloads become columns: flacc.score, flacc.components.face. */
function flatten(obj, prefix, out) {
  out = out || {};
  prefix = prefix || '';
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var v = obj[k];
    var key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      flatten(v, key, out);
    } else if (Array.isArray(v)) {
      out[key] = v.map(function (x) {
        return typeof x === 'object' ? JSON.stringify(x) : x;
      }).join('; ');
    } else {
      out[key] = v;
    }
  }
  return out;
}

/* ---------------- idempotency ---------------- */

function seenIndex() {
  var cache = CacheService.getScriptCache();
  return { cache: cache, local: {} };
}

function markSeen(idx, uuid) {
  idx.local[uuid] = true;
  idx.cache.put('uuid:' + uuid, '1', 21600); // six hours
}

/**
 * Cache first, then a column scan. The scan is the fallback that makes this
 * correct rather than merely fast: a cache eviction must not create a
 * duplicate row.
 */
function isDuplicate(ss, form, uuid, idx) {
  if (idx.local[uuid]) return true;
  if (idx.cache.get('uuid:' + uuid)) return true;
  var sheet = ss.getSheetByName(form);
  if (!sheet || sheet.getLastRow() < 2) return false;
  var col = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf('submission_uuid') + 1;
  if (col === 0) return false;
  var values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === uuid) return true;
  }
  return false;
}

/* ---------------- roster ---------------- */

function roster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var enrol = ss.getSheetByName('01_enrolment');
  var intra = ss.getSheetByName('03_intraop');
  var pacu = ss.getSheetByName('04_pacu_t0');
  var preop = ss.getSheetByName('02_preop');
  if (!enrol || enrol.getLastRow() < 2) return [];

  var byStudy = {};
  rows(enrol).forEach(function (r) {
    if (!r.study_number) return;
    byStudy[r.study_number] = {
      study_number: r.study_number,
      // Age is derived here and the date of birth never leaves the workbook.
      age_days: r['age_days'] || null,
      age_months: r['age_months'] || null,
      cognitive_impairment: false,
    };
  });
  if (preop) rows(preop).forEach(function (r) {
    var c = byStudy[r.study_number];
    if (!c) return;
    c.cognitive_impairment = r.cognitive_impairment === true || r.cognitive_impairment === 'true';
    c.weight_kg = r.weight_kg || null;
    c.procedure_category = r.procedure_category || null;
    if (r.age_days) c.age_days = r.age_days;
    if (r.age_months) c.age_months = r.age_months;
  });
  if (intra) rows(intra).forEach(function (r) {
    var c = byStudy[r.study_number];
    if (c && r.anaesthesia_end) c.anaesthesia_end = r.anaesthesia_end;
    if (c && r['block_at']) c.block_at = r['block_at'];
  });
  if (pacu) rows(pacu).forEach(function (r) {
    var c = byStudy[r.study_number];
    if (c && r.pacu_arrival_at) c.pacu_arrival = r.pacu_arrival_at;
  });

  var out = [];
  for (var k in byStudy) {
    var child = byStudy[k];
    NEVER_RETURN.forEach(function (f) { delete child[f]; });
    out.push(child);
  }
  return out;
}

function rows(sheet) {
  if (sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  return values.slice(1).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/* ---------------- audit ---------------- */

function audit(ss, body, serverTs, nAccepted, nDuplicate, nRejected, note) {
  var sheet = ss.getSheetByName('_audit');
  if (!sheet) {
    sheet = ss.insertSheet('_audit');
    sheet.appendRow(['server_ts', 'device_id', 'rater_id', 'app_version', 'schema_version',
      'n_submitted', 'n_accepted', 'n_duplicate', 'n_rejected', 'max_latency_s', 'note']);
    sheet.setFrozenRows(1);
  }
  var subs = body.submissions || [];
  var maxLatency = 0;
  subs.forEach(function (s) {
    if (!s.clientTs) return;
    var d = (new Date(serverTs) - new Date(s.clientTs)) / 1000;
    if (d > maxLatency) maxLatency = Math.round(d);
  });
  sheet.appendRow([serverTs, body.deviceId || '', body.raterId || '', body.appVersion || '',
    body.schemaVersion || '', subs.length, nAccepted, nDuplicate, nRejected, maxLatency, note || '']);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
