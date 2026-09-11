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
lib/render.js         schema → DOM, plus the computed-field derivations
app.js                routing, due-list screen, enrolment, assessment
index.html styles.css sw.js manifest.webmanifest
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
- Tokens belong to **collectors**, not devices (`RATER_IDS` in `Code.gs`).
  Collectors open a shared link on their own phones; the device id is minted
  per browser in `app.js` and never typed.
- `tests/appsScript.test.js` runs `Code.gs` in a VM sandbox with fake Google
  services. Editing the endpoint without running it there means shipping
  untested code to a place you cannot debug.

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
