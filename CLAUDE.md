# Pediatric Perioperative Pain eCRF

Offline-first electronic case report form for a prospective observational study of
acute postoperative pain in children, run over 48-hour high-volume surgical camps.
Static site on GitHub Pages → one Apps Script endpoint → one Google Sheets workbook.
No server, no framework, no build step.

The full design rationale lives in the plan artifact; this file is the working
contract for editing the code.

## Non-negotiables

Read these before changing anything. Each one is a study-integrity or
data-protection constraint, not a style preference.

1. **Date of birth appears in `01_enrolment` and nowhere else.** The workbook is
   an identifiable dataset and containment is what keeps the analysis extract,
   the roster endpoint and the QC views shareable. `tests/schema.test.js` fails
   the build if any other form declares it. Never add a second DOB field, never
   echo DOB into a derived view, never return it from the roster endpoint.
2. **`schema/params.json` holds study endpoints, not settings.** Every value has
   a published source recorded beside it. Changing one changes what the study
   measures. Bump `paramsVersion`, record the countersignature, and never edit
   mid-camp — a changed threshold silently splits the dataset.
3. **Raw rows are append-only.** Corrections append a new row carrying
   `supersedes_uuid`. Nothing is edited or deleted in place. `_derived` resolves
   the latest version per record.
4. **Routing uses completed calendar age, never a day count.** See
   `lib/age.js`. Seven years is 2556 or 2557 days depending on leap years; the
   protocol rule is "has had their Nth birthday", so express it that way.
5. **The rater never picks a pain scale.** `lib/routing.js` derives it. Overrides
   exist but are logged with a reason code, which preserves `tool_used` as an
   honest covariate.
6. **Totals are computed from itemised responses, never typed.** This is why
   `paedTotal` does its own reverse-scoring of items 1–3 — hand-reversal at the
   bedside is the classic PAED error.
7. **One hard block on clinical grounds only: local anaesthetic over the
   weight-adjusted ceiling.** Everything else clinical warns and records.
   Refusing to record what actually happened corrupts the dataset — that is why
   codeine/tramadol under 12 flags to QC rather than blocking.
8. **Collection is not always real-time, and the app must never pretend it
   was.** Ratios and emergencies mean assessments get written on paper and
   typed up later. `entry_mode` records which, `assessed_at` is the clinical
   event while `client_ts` is the typing, and a timepoint whose window has
   closed stays enterable from the child screen. Never add a rule that blocks a
   late record: a gap is worse than a late row, and a silently-wrong timestamp
   is worse than both.

## Layout

```
schema/params.json    protocol parameters + their published sources
schema/crf.v1.json    the data dictionary: 10 modules, all items, branching
lib/params.js         loadParams() / params() — call loadParams at startup
lib/age.js            calendar age arithmetic (days, months, years, label)
lib/routing.js        age + impairment → instrument
lib/studyNumber.js    PPP-<site>-<seq>-<check>, mod-11 check character
lib/scoring.js        FLACC · PAED · FPS-R · m-YPAS-SF · LA dose · MME · PACU adjudication
lib/derive.js         cross-record endpoints: MME/kg, AUC, rebound, breakthrough, completeness
lib/validate.js       BLOCK vs WARN tiers, branching, cross-field rules
lib/dueList.js        per-child schedule → the home screen's next action
lib/outbox.js         batching, backoff, ACK reconciliation (pure, testable)
lib/store.js          IndexedDB: outbox · roster · local records
lib/sync.js           the network half: POST, roster pull, clock check
index.html + form.js  THE APP — one page, six questions, one button
lib/render.js         schema → DOM (used by the full app only)
full.html + app.js    the full eCRF: due list, enrolment, all ten modules.
                      Kept working, but it is not the front door.
config.js styles.css sw.js manifest.webmanifest
apps-script/Code.gs   the endpoint — source of truth, pasted into the bound script
tests/                node:test, zero dependencies
```

**Out of scope by decision, do not reintroduce:** barcode/DataMatrix scanning
and push notifications. The team is deliberately non-technical and collectors
use their own phones, so anything needing hardware, OS permissions or an
on-site debugger will fail in the field. Study numbers are typed, which is why
the mod-11 check character in `lib/studyNumber.js` is load-bearing.

Not built yet: module polish (M6–M10 render from schema but are untested in
anger), the `_derived` / `_qc` builders, the nightly analysis extract.

## Commands

```
npm test              # node --test tests/
npm run test:watch
```

No dependencies and no install step. Node 20+.

## Conventions

- ES modules, plain JavaScript, no TypeScript, no build.
- Library functions are pure and total: return a value or throw. No silent
  coercion, no `null` standing in for zero. `blockDurationHours` returns `null`
  when a timestamp is missing, never `0`.
- Parameters are read through `params()`, never imported from JSON directly, so
  the browser and Node can both supply them and tests can swap variants.
- Validation returns arrays of `{level, field, code, message}`. Messages are
  written for a nurse at 3 a.m.: say what is wrong and what to do about it.
- Clinical constants live in `params.json`. If you find a number in `lib/`, it
  is either arithmetic or a bug.
- Tests assert behaviour that matters clinically, and the test name says why.
  Boundary cases (birthdays, dose ceilings, window edges) earn their own test.

## Gotchas

- `params.json` contains `_source` / `_note` / `_basis` keys alongside real
  values. Anything iterating `Object.values()` or `Object.entries()` must skip
  keys beginning with `_`.
- `painBands` values are `[lo, hi]` inclusive pairs.
- MME conversion is route-aware and unit-strict: `doseMme` throws on a unit
  mismatch rather than converting. Fentanyl is per mcg, everything else per mg.
- `onTimeFlag` returns `applicable: false` for T0 (event-anchored) and for
  unscheduled rows. Do not read `onTime` without checking `applicable`.
- Age boundaries in tests are deliberately one day either side of a birthday.
  If you change `routing` params, those tests should fail — that is the point.
- **`config.js` is the only file that changes between camps** — endpoint URL,
  camp key, site, and the list of collector names. Nothing is typed on a phone:
  a collector taps their name once and never sees a setting. `campKey` in
  `config.js` must match `CAMP_KEY` in `Code.gs`.
- The camp key is visible in page source by design. It stops drive-by writes to
  a workbook holding dates of birth; it is not authentication. Rater identity
  is attribution, not a login.
- `tests/appsScript.test.js` runs `Code.gs` in a VM sandbox with fake Google
  services. Editing the endpoint without running it there means shipping
  untested code to a place you cannot debug.
- **Apps Script sometimes answers a POST with a redirect Chrome follows as a
  GET**, so the reply arrives from `doGet` as `{"error":"unknown_mode"}`.
  Measured live: the write has already succeeded — only the acknowledgement is
  lost. `post()` therefore retries, and the submission uuid makes the retry a
  duplicate rather than a second row. This is the reason uuids exist; do not
  remove them and do not treat `unknown_mode` as a delivery failure.
- **Changing `Code.gs` needs TWO manual steps by the owner: paste the file into
  the Apps Script editor, *then* deploy a new version.** Saying "redeploy"
  alone is not enough and has already cost one debugging round — redeploy
  republishes whatever is in the editor. A sudden `unauthorised` on writes is
  the signature of a stale paste.

## The form is the product

`index.html` + `crf.js` + `crf.css` is the whole app: the clinical research
form, laid out as the paper form reads — an administrative header then five
numbered modules, each with its own Save. Different people fill different
modules at different hours, so no module waits on another.

| Module | Sheet tab | Filled by |
|---|---|---|
| Header + 1 Preoperative baseline | `01_baseline` | enrolling clinician |
| 2 Intraoperative log | `02_intraop` | theatre |
| 3 PACU emergence (PAED ×3) | `03_paed` | recovery |
| 4 Ward pain (×5 timepoints) | `04_ward_pain` | ward, over 48 h |
| 5 Regional offset & recovery | `05_recovery` | before discharge |

**Age is recorded in completed MONTHS, not a date of birth.** This came from
the clinical form and it is a genuine improvement: months are not a direct
identifier, so the workbook is no longer an identifiable dataset and the
containment rules that used to govern `01_enrolment` no longer bind. Do not
reintroduce a birth date.

Everything the paper form asks a human to work out, the app works out instead:
BMI, the PAED total (with items 1–3 reverse-scored so nobody does it by hand),
which pain scale applies from the age, the weight-adjusted OME, and whether a
local anaesthetic dose is over the ceiling. Adding a field costs a busy person
time five times per child — ask before adding one.

## Deployed

- App: https://chiz720.github.io/pediatric-pain-ecrf/ (GitHub Pages, `main`, root)
- Repo: https://github.com/chiz720/pediatric-pain-ecrf — **public**. No tokens,
  no endpoint URL, no workbook address. `LOCAL.md` holds those and is ignored.
- Endpoint and workbook: see `LOCAL.md`.

A push to `main` republishes the app. Bump `VERSION` in `sw.js` with any change
to cached files, or devices keep serving the old copy.

## Running it

```
python3 -m http.server 8787     # any static server; the app is plain files
open http://localhost:8787/index.html
```

The service worker precaches the shell, so **during development a code change
will not appear until the old worker is gone**. Unregister it, clear caches,
then reload *twice* — the first reload installs the new worker, the second is
served by it. This is the single most confusing thing about working on this
repo; it is correct production behaviour and deliberately not disabled.

## Status

Phases 1 and 2 are complete and tested (119 tests).

- **Phase 1** — schema, parameters, scoring, routing, validation.
- **Phase 2** — schema-driven renderer, IndexedDB outbox, service worker, sync
  client, due-list home screen, and the enrolment → assessment → outbox path
  verified end to end in a browser.
- **Endpoint** — `apps-script/Code.gs` written and tested against sandboxed
  Google services (19 tests). Not yet deployed against the live workbook; see
  `docs/SETUP.md`.

Phases 3–6 remain: remaining module polish and barcode scan, endpoint
hardening with the `_derived` / `_qc` builders, the calibration module, and the
dress rehearsal.
