  /**
  * PPP eCRF endpoint.
  *
  * Bound to the study workbook, deployed as a web app executing as the study
  * account, access "Anyone with the link".
  *
  * SETUP — paste, save, deploy. There is nothing to configure and nothing to
  * run first. Sheets create themselves on first write.
  *
  *   Deploy > New deployment > Web app
  *     Execute as:      Me
  *     Who has access:  Anyone with the link
  *
  * After ANY edit to this file: Deploy > Manage deployments > pencil >
  * Version: New version > Deploy. The URL never changes.
  *
  * CAMP_KEY must match campKey in config.js. It is the only shared secret, it
  * is visible to anyone who reads the app's source, and its job is narrow: stop
  * the workbook accepting writes from anything that merely stumbles on this
  * URL. To lock everyone out — a lost phone, a leaked link — change it in both
  * files and redeploy.
  */

  var CAMP_KEY = 'CAMP-2026-KN';
  var SCHEMA_VERSION = '1.0.0';

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
          if (body.schemaVersion !== SCHEMA_VERSION) {
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
        schemaVersion: SCHEMA_VERSION,
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
        schemaVersion: SCHEMA_VERSION,
      });
    }
    // A POST diverted here by a cached redirect lands with no mode. Say so
    // explicitly rather than returning something a client could mistake for an
    // acknowledgement.
    return json({ ok: false, error: 'unknown_mode', hint: 'POST to /exec directly; do not reuse a cached redirect.' });
  }

  /* ------------------------------------------------------------------ */

  function authorise(body) {
    if (!body || body.token !== CAMP_KEY) return { ok: false, error: 'unauthorised' };
    return { ok: true };
  }

  function tokenValid(token) {
    return token === CAMP_KEY;
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
