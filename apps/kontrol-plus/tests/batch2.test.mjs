import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TRAILER_FIELDS } from '../src/lib/registry.js';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const readRoot = (file) => fs.readFileSync(new URL('../../../' + file, import.meta.url), 'utf8');
const css = read('src/crm.css');

test('п.1: картка причепа без ТО / техогляду / тахографа, кнопки за розміром тексту', () => {
    const keys = TRAILER_FIELDS.map((f) => f.key);
    for (const k of ['inspection_on', 'tachograph_on', 'service_on']) assert.equal(keys.includes(k), false, k);
    for (const k of ['oscpv_on', 'kasko_on', 'green_card_on']) assert.ok(keys.includes(k), k);
    const fleet = read('src/views/fleet.js');
    assert.match(fleet, /const TRAILER_DATE_KEYS = \['oscpv_on', 'kasko_on', 'green_card_on'\];/);
    assert.match(fleet, /TRAILER_DATE_KEYS\.map/);
    assert.match(css, /\.kpc-head > \.btn, #kp-crm \.kpc-actions > \.btn \{ flex: 0 0 auto; width: auto;/);
});
