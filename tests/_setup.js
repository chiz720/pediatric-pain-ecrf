import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadParams } from '../lib/params.js';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..');

export const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

export const PARAMS = readJson('schema/params.json');
export const CRF = readJson('schema/crf.v1.json');

loadParams(PARAMS);
