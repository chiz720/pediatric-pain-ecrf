# Setting up the study workbook and endpoint

Set this up once. After that, each data collector needs nothing but a link and
their own token — they open it on their own phone or laptop, over wifi or
cellular, and add it to their home screen.

The workbook is **PPP eCRF — Pediatric Perioperative Pain Study (data)**, in the
study Google account's Drive. Its address and the deployed endpoint URL are in
`LOCAL.md`, which is deliberately not committed — this repository is public,
and there is no reason to publish the address of an identifiable dataset.

---

## 1. The endpoint

1. Open the workbook. **Extensions → Apps Script.**
2. Delete the placeholder `function myFunction() {}`.
3. Paste the entire contents of `apps-script/Code.gs` from this repo.
4. Save (the disk icon). Name the project `PPP eCRF endpoint`.
5. In the function dropdown at the top, choose **`setup`**, then press **Run**.
   - Google will ask for permission the first time. Choose your account,
     then **Advanced → Go to PPP eCRF endpoint (unsafe)** → **Allow**.
     This warning appears for every unverified personal script; it is asking
     whether you trust your own code.
6. Go back to the workbook. There is now a **`_raters`** tab holding one token
   per data collector. That is where tokens live from now on — you never need
   to open the script again to read them. Fill in the `name` and `role`
   columns so you know whose token is whose.
7. Back in the Apps Script editor: **Deploy → New deployment**.
   - Click the gear next to "Select type", choose **Web app**.
   - Description: `v1`
   - **Execute as: Me**
   - **Who has access: Anyone with the link**
   - **Deploy**, approve again if asked.
8. Copy the **Web app URL**. It ends in `/exec`. That is the endpoint.

> **Re-deploying after a code change:** Deploy → Manage deployments → pencil
> icon → Version: New version → Deploy. Editing the code alone changes nothing
> that tablets can see until you do this. The URL stays the same.

## 2. Each data collector

The app lives at **https://chiz720.github.io/pediatric-pain-ecrf/**

Send them two things: **that link** and **their own token** from the
`_raters` tab. Send the token separately from the link — a message containing
both is a credential someone can forward.

They then, once:

1. Open the link. Tap **Settings**.
2. Fill in:
   - **Your rater ID** — e.g. `RN-03`, exactly as written in `_raters`
   - **Your token** — their own row from `_raters`
   - **Endpoint URL** — the `/exec` URL from step 8 (same for everyone)
   - **Site code** — two capital letters, e.g. `KN`
   - **Rater has passed calibration** — `No` until they have. While this is No,
     everything they send is tagged `training=1` and excluded from analysis.
3. **Save settings**, then **Check clock**. If it reports a skew over two
   minutes, fix the phone's clock before collecting anything — every derived
   interval in the study depends on these timestamps.
4. **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: menu →
   Add to Home screen), then open it once from there. This is what makes it
   keep working when the signal drops.

Do all four steps **on wifi, before the camp starts.** The first open is the
only one that genuinely needs a connection.

Tokens belong to people, not handsets. Nobody should use someone else's: the
endpoint rejects a mismatched pair, and rows are attributed to whoever the
token belongs to, which is what the inter-rater analysis depends on. Each
browser mints its own device id automatically — nothing to type.

**If someone loses their phone or leaves the camp**, open the Apps Script
editor, run `rotateToken` with their rater id, and their old token stops
working immediately. Nobody else is disturbed.

### Is this an online app or an offline one?

**Online, with offline as a safety net.** Nobody chooses a mode, and there is no
setting for it. It behaves the same either way.

- **The first open needs signal.** That is when the phone downloads the app.
  Do this on wifi before the camp starts — not standing in the ward.
- **After that it opens with or without signal**, because the phone keeps its
  own copy. This is what "Add to Home Screen" is for.
- **Every record saves to the phone first, then goes to the workbook a second
  later.** That ordering is the whole point: a dead spot in a corridor, a lift,
  a concrete-walled recovery bay, or a phone in battery-saver mode at 3 a.m.
  cannot lose an assessment somebody just did.
- On a normal connection rows reach the workbook within seconds. Nobody needs
  to "sync" anything.

**The number in the top right** is how many records are still waiting. Normally
it sits at `0` and blinks to `1` for a moment after each save.

| What you see | What it means | What to do |
|---|---|---|
| `0`, green | Everything is in the workbook | Nothing |
| `1–2`, amber, briefly | Normal, mid-send | Nothing |
| A number that climbs and stays | This phone has lost signal | The work is safe. Walk somewhere with coverage; it sends itself |
| Red dot | The phone knows it is offline | Keep working. It catches up by itself |

Tapping the number forces a send early. It is never required.

### Several collectors, one camp

Everyone works from the same link against the same workbook, and each phone
keeps its own copy of the child list.

- A child enrolled by one collector appears on everyone else's **Due** screen
  within about a minute, as long as those phones have signal.
- A phone that is offline still shows every child it already knows about, and
  still records assessments for them. It catches up when signal returns.
- **This is the one thing that genuinely needs connectivity**: a ward nurse
  cannot assess a child they have never received. If someone will be working
  out of coverage, have them open the app while still on wifi so their phone
  pulls the current list first.

### What runs where

| Thing | Where it lives | Needs signal? |
|---|---|---|
| The app itself | GitHub Pages, cached on the phone | First open only |
| Blank forms, scoring, dose checks, the due list | On the phone | No |
| Saving a record | On the phone | No |
| A record reaching the workbook | Apps Script → Google Sheets | Yes, eventually |
| Seeing children enrolled by other people | Apps Script → the phone | Yes |

The app link is a public web address and can be shared freely — it contains no
patient data and no credentials. Everything that touches the workbook needs a
token.

### When you cannot collect in real time

You will not always have someone free at T+18 h with a phone in their hand.
Ratios, emergencies and ward logistics come first. The study is designed for
that, and none of it counts as a protocol deviation.

**Use the paper sheet.** `admin/paper.html` prints an A4 tally sheet — one per
child, clipped to the cot. All thirteen timepoints, the FLACC descriptors, and
the score bands are printed on it, so a nurse can score without a phone.
Print a stack before the camp opens.

**Then type it in, and say where it came from.** Every assessment asks *How was
this recorded*:

| Answer | When to use it | What it means for the analysis |
|---|---|---|
| At the bedside | Entered on the spot | Strongest evidence |
| From written notes | Written on the tally sheet, typed up later | Fine. Use this whenever paper was used |
| From recall | Neither — reconstructed from memory | Recorded, flagged, and may be excluded |

**Set the assessment time to when it actually happened**, not when you typed
it. The app records both, and warns you if a record claims to be bedside but is
being entered hours later. Every derived number in the study — the pain
trajectory, the rebound window, time to first rescue — depends on that time
being the clinical event.

**A late timepoint is still worth entering.** Open the child from the
**Children** tab and you will see their whole schedule; anything outstanding,
including windows that have closed, can be filled in. A late record is far
better than a gap. The app records how late it was, and the analysis can
account for it.

Be honest about *From recall*. It is not a failure — it is a weaker
measurement, and the study can only handle it correctly if it knows.

## 3. Protecting the workbook

The workbook holds dates of birth, so it is an identifiable dataset.

- **Share → General access → Restricted.** Never "anyone with the link".
- Add collaborators by name only. Review the list before the camp starts.
- Share → gear icon → untick **Viewers can download, print, or copy**.
- Turn on 2-step verification for every account with access.

## Checking it works

In the Apps Script editor, run `setup` again — it is safe to re-run and will
not change tokens already handed out. Then, from any browser:

```
<your /exec URL>?mode=health
```

should return something like:

```json
{"ok":true,"serverTs":"2026-09-11T17:20:00.000Z","schemaVersion":"1.0.0"}
```

If you get an HTML login page instead, the deployment's access is not set to
"Anyone with the link".

Then do one real end-to-end check before the camp: enrol a fake child with a
study number you will recognise (`PPP-ZZ-9999-…`), record one assessment, wait
for the pending count to reach zero, and confirm the rows appear in
`01_enrolment` and `05_pain_obs`. Delete nothing afterwards — mark the test
rows by putting `TEST` in the `_audit` note, or simply exclude that study
number in the analysis. Raw rows are append-only by design.
