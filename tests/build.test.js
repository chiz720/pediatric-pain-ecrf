import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const swVersion = () => read('sw.js').match(/const VERSION = '([^']+)'/)?.[1];
const appVersion = () => read('crf.js').match(/const APP_VERSION = '([^']+)'/)?.[1];

/*
 * Two constants carry the build number and they fail in opposite directions.
 *
 * sw.js VERSION names the cache, so it decides what a device fetches: leave it
 * behind and a phone keeps serving the old crf.js forever, because the cache it
 * already holds still has the right name.
 *
 * crf.js APP_VERSION is written into app_version on every row, so it decides
 * what the data claims produced it: leave it behind and rows from the new build
 * are attributed to the old one. A wrong provenance value is worse than a
 * missing one, because nothing about the row looks suspect.
 *
 * Both have been left behind in real deploys. The habit is not enough.
 */
test('the service worker and the app agree on the build number', () => {
  const sw = swVersion();
  const app = appVersion();

  assert.ok(sw, 'sw.js has no VERSION — the cache name is what makes a deploy reach a device');
  assert.ok(app, 'crf.js has no APP_VERSION — app_version is provenance on every row');
  assert.equal(app, sw,
    `Build numbers have drifted: crf.js APP_VERSION is ${app} but sw.js VERSION is ${sw}. `
    + 'Move both together — one decides what a device fetches, the other records what wrote a row.');
});

/*
 * The camp key is not a secret, but a mismatch is silent and total: every write
 * comes back unauthorised, and the first person to find out is a nurse at the
 * bedside whose save will not go through.
 */
test('the camp key in the endpoint matches the one the app sends', () => {
  const inScript = read('apps-script/Code.gs').match(/var CAMP_KEY = '([^']+)'/)?.[1];
  const inConfig = read('config.js').match(/campKey: '([^']+)'/)?.[1];

  assert.ok(inScript, 'Code.gs has no CAMP_KEY');
  assert.ok(inConfig, 'config.js has no campKey');
  assert.equal(inConfig, inScript,
    `Camp keys differ: config.js sends ${inConfig}, Code.gs expects ${inScript}. `
    + 'Every write would come back unauthorised.');
});

/*
 * A file the service worker precaches but the repo does not have is a deploy
 * that installs nothing: the install step fetches every shell entry and throws
 * if one is missing, so the new worker never activates and devices stay on the
 * old build with no visible error.
 */
test('every precached file exists', () => {
  const shell = read('sw.js').match(/const SHELL = \[([\s\S]*?)\];/)?.[1] || '';
  const paths = [...shell.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

  assert.ok(paths.length > 5, 'Could not parse the precache list out of sw.js');
  for (const p of paths) {
    assert.doesNotThrow(() => readFileSync(join(root, p)),
      `sw.js precaches ${p}, which is not in the repo. The worker would fail to install.`);
  }
});
