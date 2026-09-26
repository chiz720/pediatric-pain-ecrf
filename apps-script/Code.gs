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

  var NEVER_RETURN = ['date_of_birth', 'hospital_number'];

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

      // Allocation happens inside the same lock the writes take. That is what
      // makes "the next number" mean anything with three centres enrolling at
      // the same time — two phones asking in the same second are serialised
      // here, and each leaves with its own number.
      if (body.mode === 'allocate') return json(allocate(ss, body));

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
    // Enrolment check. Three centres enrol at the same time off one paper log
    // each, so the one thing worth asking the workbook is whether a serial has
    // already been used. It answers a single boolean about a number the caller
    // supplied, which is the most a GET on this workbook is ever allowed to do.
    if (mode === 'check') {
      var p = e.parameter || {};
      if (!tokenValid(p.token)) return json({ ok: false, error: 'unauthorised' });
      return json({ ok: true, enrolled: hasBaseline(p.sn) });
    }
    // Who exists and what has been recorded — completion only, never content.
    // A ward round runs on several phones and none of them can see the others;
    // this is the only thing that lets one know what another already did.
    if (mode === 'roster') {
      var rp = e.parameter || {};
      if (!tokenValid(rp.token)) return json({ ok: false, error: 'unauthorised' });
      return json(roster(SpreadsheetApp.getActiveSpreadsheet(), rp.centre));
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

  /* ---------------- study number allocation ---------------- */

  /**
  * Hand out the next study number for a centre: PPP-CH-0001, PPP-CH-0002.
  *
  * The counter lives in Script Properties, one per centre, and is reconciled
  * against the sheet before every allocation — so a cleared property, a
  * restored workbook or a first run can never reissue a number that
  * 01_baseline already holds. There is still no setup step: the first call
  * creates what it needs.
  */
  function allocate(ss, body) {
    var centre = String(body.centre || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(centre)) return { ok: false, error: 'bad_centre' };

    var props = PropertiesService.getScriptProperties();

    // Idempotency, and the reason requestId exists. Apps Script sometimes
    // answers a POST with a redirect the browser follows as a GET, so the
    // client retries — and a retry must return the number already issued
    // rather than burning a second one.
    var memoKey = body.requestId ? 'alloc:' + body.requestId : null;
    if (memoKey) {
      var already = props.getProperty(memoKey);
      if (already) {
        return { ok: true, studyNumber: already, centre: centre, reissued: true };
      }
    }

    var seqKey = 'seq:' + centre;
    var current = Number(props.getProperty(seqKey) || 0);
    var onSheet = highestSequence(ss, centre);
    if (onSheet > current) current = onSheet;

    var next = current + 1;
    if (next > 9999) return { ok: false, error: 'sequence_exhausted' };

    var studyNumber = 'PPP-' + centre + '-' + pad4(next);
    props.setProperty(seqKey, String(next));
    if (memoKey) props.setProperty(memoKey, studyNumber);

    return { ok: true, studyNumber: studyNumber, sequence: next, centre: centre };
  }

  /** The highest sequence 01_baseline already holds for a centre, or 0. */
  function highestSequence(ss, centre) {
    var sheet = ss.getSheetByName('01_baseline');
    if (!sheet || sheet.getLastRow() < 2) return 0;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var col = headers.indexOf('study_number') + 1;
    if (col === 0) return 0;
    var prefix = 'PPP-' + centre + '-';
    var values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
    var top = 0;
    for (var i = 0; i < values.length; i++) {
      var v = String(values[i][0]).toUpperCase();
      if (v.indexOf(prefix) !== 0) continue;
      var n = Number(v.slice(prefix.length));
      if (n > top) top = n;
    }
    return top;
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  /* ---------------- enrolment check ---------------- */

  /**
  * True when 01_baseline already holds a row for this study number.
  *
  * Reads one column and returns nothing from it — no row, no field, no
  * clinical value, and never the hospital number that sits in that tab.
  */
  function hasBaseline(studyNumber) {
    if (!studyNumber) return false;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('01_baseline');
    if (!sheet || sheet.getLastRow() < 2) return false;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var col = headers.indexOf('study_number') + 1;
    if (col === 0) return false;
    var wanted = String(studyNumber).toUpperCase();
    var values = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).toUpperCase() === wanted) return true;
    }
    return false;
  }

  /* ---------------- roster ---------------- */

  /**
  * Which children exist, and what has been recorded for each. Nothing else.
  *
  * The problem it solves is that a ward round is worked on several phones and
  * none of them can see the others. A child scored at T6 by one nurse reads as
  * still due to the next, who scores it again — a duplicate the study resolves
  * by supersedes but would rather not have, and worse, a real gap looks
  * identical to a timepoint somebody else already covered.
  *
  * It answers with study numbers and completion only: which modules are in,
  * which timepoints of the repeating ones are in. No score, no drug, no date,
  * and above all no hospital number. That is enforced twice — this reads only
  * the study_number and timepoint columns and never asks a sheet for anything
  * else, and scrub() then refuses to emit a payload containing a forbidden key
  * at all. The second check exists because the first is a promise about code
  * that someone will later edit.
  *
  * Scoped to one centre because a phone at Chuka has no business holding
  * Meru's roster, and capped because an unbounded list is a slow request on a
  * camp phone and an accident waiting to happen on a big workbook.
  */
  var ROSTER_MAX = 500;

  var ROSTER_FORMS = [
    { sheet: '01_baseline',  key: 'm1', repeating: false },
    { sheet: '02_intraop',   key: 'm2', repeating: false },
    { sheet: '03_paed',      key: 'm3', repeating: true  },
    { sheet: '04_ward_pain', key: 'm4', repeating: true  },
    { sheet: '05_recovery',  key: 'm5', repeating: false },
  ];

  function roster(ss, centre) {
    var wanted = String(centre || '').toUpperCase();
    if (wanted && !/^[A-Z]{2}$/.test(wanted)) return { ok: false, error: 'bad_centre' };
    var prefix = wanted ? 'PPP-' + wanted + '-' : null;

    var byChild = {};
    ROSTER_FORMS.forEach(function (form) {
      var sheet = ss.getSheetByName(form.sheet);
      if (!sheet || sheet.getLastRow() < 2) return;

      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var snCol = headers.indexOf('study_number') + 1;
      if (snCol === 0) return;
      var tpCol = headers.indexOf('timepoint') + 1;

      var n = sheet.getLastRow() - 1;
      var sns = sheet.getRange(2, snCol, n, 1).getValues();
      var tps = (form.repeating && tpCol > 0) ? sheet.getRange(2, tpCol, n, 1).getValues() : null;

      for (var i = 0; i < n; i++) {
        var sn = String(sns[i][0] || '').toUpperCase();
        if (!sn) continue;
        if (prefix && sn.indexOf(prefix) !== 0) continue;

        var child = byChild[sn] || (byChild[sn] = { sn: sn });
        if (!form.repeating) {
          child[form.key] = true;
        } else {
          var tp = tps ? String(tps[i][0] || '') : '';
          if (!tp) continue;
          if (!child[form.key]) child[form.key] = [];
          if (child[form.key].indexOf(tp) === -1) child[form.key].push(tp);
        }
      }
    });

    var children = Object.keys(byChild).sort().map(function (sn) { return byChild[sn]; });
    var truncated = children.length > ROSTER_MAX;

    return scrub({
      ok: true,
      serverTs: new Date().toISOString(),
      centre: wanted || null,
      count: children.length,
      truncated: truncated,
      children: truncated ? children.slice(0, ROSTER_MAX) : children,
    });
  }

  /**
  * Refuse to emit anything carrying an identifier, whatever built it.
  *
  * NEVER_RETURN was declared long before anything could return data, which
  * made it a comment with a variable name. This is what turns it into a rule:
  * a later edit that widens the roster to "just also include the weight" and
  * sweeps up a hospital number with it fails loudly here instead of quietly
  * publishing one.
  */
  function scrub(payload) {
    var seen = JSON.stringify(payload);
    for (var i = 0; i < NEVER_RETURN.length; i++) {
      if (seen.indexOf('"' + NEVER_RETURN[i] + '"') !== -1) {
        return { ok: false, error: 'identifier_in_payload', field: NEVER_RETURN[i] };
      }
    }
    return payload;
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
