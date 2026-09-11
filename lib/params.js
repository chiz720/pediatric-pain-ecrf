/**
 * Protocol parameters.
 *
 * Every value in params.json is a study endpoint definition. The library reads
 * them through this module so that the browser (fetch) and Node (readFile) can
 * both supply them, and so a test can swap in a variant without touching disk.
 */

let PARAMS = null;

export function loadParams(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('loadParams: expected a params object');
  PARAMS = obj;
  return PARAMS;
}

export function params() {
  if (!PARAMS) throw new Error('Protocol parameters not loaded. Call loadParams(json) at startup.');
  return PARAMS;
}

export function isLoaded() {
  return PARAMS !== null;
}
