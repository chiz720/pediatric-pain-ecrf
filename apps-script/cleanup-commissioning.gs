/**
 * ONE-OFF: clear commissioning data and reset the study-number counters.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT PART OF Code.gs
 *
 * Raw rows are append-only. Corrections append a row carrying supersedes_uuid;
 * nothing is edited or deleted in place. That rule protects the study record,
 * and a delete function reachable from doGet or doPost — behind a camp key that
 * is visible in the page source — would put a hole straight through it.
 *
 * So this lives in its own file, is never called by doGet or doPost, and runs
 * only from the Apps Script editor, which means only someone signed in as the
 * owner can run it at all. Delete the file when you are done.
 *
 * WHY IT IS DEFENSIBLE HERE
 *
 * The workbook was created on 2026-09-25 and holds nothing but commissioning
 * rows: there is no study record to protect yet, because no child has been
 * enrolled. Running this after the first real enrolment would be a different
 * act entirely, which is why it names the study numbers it will remove rather
 * than clearing whatever it finds.
 *
 * HOW TO RUN
 *
 *   1. Apps Script editor > + (Files) > Script, name it "cleanup"
 *   2. Paste this whole file in and save
 *   3. Choose "dryRunCleanup" from the function dropdown > Run
 *   4. Read the log. It says exactly what it would delete and touches nothing.
 *   5. Only if the log is right: choose "runCleanup" > Run
 *   6. Delete the file afterwards
 *
 * It does NOT redeploy anything. Editor-run functions do not need a new
 * version, and the web app is unaffected.
 */

/** The commissioning subjects. Nothing outside this list is ever touched. */
var CLEANUP_SUBJECTS = [
  'PPP-ZZ-0001',
  'PPP-CH-0002',
  'PPP-ME-0001',
  'PPP-GU-0002'
];

var CLEANUP_SHEETS = [
  '01_baseline', '02_intraop', '03_paed', '04_ward_pain', '05_recovery'
];

/**
 * The audit tab is deliberately left alone.
 *
 * It is the log of what the endpoint did, not clinical data about a child, and
 * it is the only evidence that today's commissioning happened at all. Clearing
 * it would tidy away the record of the very testing that proved the endpoint
 * works. Set this true if you disagree.
 */
var CLEANUP_AUDIT = false;

function dryRunCleanup() { cleanup_(true); }
function runCleanup() { cleanup_(false); }

function cleanup_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var label = dryRun ? 'DRY RUN — nothing changed' : 'LIVE RUN';
  var lines = [label, 'Subjects: ' + CLEANUP_SUBJECTS.join(', '), ''];
  var wanted = {};
  CLEANUP_SUBJECTS.forEach(function (s) { wanted[String(s).toUpperCase()] = true; });

  CLEANUP_SHEETS.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { lines.push(name + ': nothing'); return; }

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var col = headers.indexOf('study_number') + 1;
    if (col === 0) { lines.push(name + ': no study_number column, skipped'); return; }

    var n = sheet.getLastRow() - 1;
    var values = sheet.getRange(2, col, n, 1).getValues();
    var doomed = [];
    for (var i = 0; i < n; i++) {
      if (wanted[String(values[i][0] || '').toUpperCase()]) doomed.push(i + 2);
    }
    if (!doomed.length) { lines.push(name + ': no matching rows'); return; }

    // Bottom-up, or deleting row 2 renumbers every row below it and the next
    // index in the list points at something else.
    if (!dryRun) {
      for (var j = doomed.length - 1; j >= 0; j--) sheet.deleteRow(doomed[j]);
    }
    lines.push(name + ': ' + doomed.length + ' row(s) at ' + doomed.join(', '));

    var left = sheet.getLastRow() - 1;
    if (!dryRun && left > 0) {
      var still = sheet.getRange(2, col, left, 1).getValues()
        .map(function (r) { return String(r[0] || ''); })
        .filter(function (v) { return wanted[v.toUpperCase()]; });
      if (still.length) lines.push('  WARNING: ' + still.length + ' matching row(s) survived');
    }
  });

  if (CLEANUP_AUDIT) {
    var audit = ss.getSheetByName('_audit');
    if (audit && audit.getLastRow() > 1) {
      var an = audit.getLastRow() - 1;
      if (!dryRun) audit.deleteRows(2, an);
      lines.push('_audit: ' + an + ' row(s)');
    }
  } else {
    lines.push('_audit: left alone on purpose');
  }

  // The counters are the half people forget. allocate() takes the HIGHER of
  // the stored property and the highest number on 01_baseline, so clearing the
  // rows without clearing these leaves seq:CH at 2 and hands the first real
  // child at Chuka PPP-CH-0003.
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var killed = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('seq:') === 0 || k.indexOf('alloc:') === 0) {
      killed.push(k + '=' + all[k]);
      if (!dryRun) props.deleteProperty(k);
    }
  });
  lines.push('', 'Script properties: ' + (killed.length ? killed.join(', ') : 'none'));

  if (!dryRun) {
    lines.push('', 'Next allocation per centre now starts at 0001.');
  } else {
    lines.push('', 'Nothing was changed. Run runCleanup to apply.');
  }

  Logger.log(lines.join('\n'));
}
