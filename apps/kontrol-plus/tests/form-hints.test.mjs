// Підказки «?» у формах КП (крім ТТН): словники відповідають справжнім полям, форми підключають спільний field-hint, без innerHTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOC_HINTS, TS_HINTS, REPAIR_HINTS, REQUISITES_HINTS, OTHER_HINTS } from '../src/lib/form-hints.js';
import { TS_FIELD_LABELS } from '../src/lib/trip-sheet.js';
import { VEHICLE_FIELDS, TRAILER_FIELDS, DRIVER_FIELDS } from '../src/lib/registry.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const all = { DOC_HINTS, TS_HINTS, REPAIR_HINTS, REQUISITES_HINTS, OTHER_HINTS };

test('підказки: тексти непорожні, короткі, без розмітки', () => {
    for (const [name, dict] of Object.entries(all)) {
        for (const [key, text] of Object.entries(dict)) {
            assert.ok(typeof text === 'string' && text.length > 5 && text.length <= 220, name + '.' + key);
            assert.doesNotMatch(text, /[<>]/, name + '.' + key);
        }
    }
    for (const spec of [...VEHICLE_FIELDS, ...TRAILER_FIELDS, ...DRIVER_FIELDS]) if (spec.hint) assert.ok(spec.hint.length <= 220 && !/[<>]/.test(spec.hint), spec.key);
});

test('підказки подорожнього листа стосуються справжніх полів', () => {
    for (const key of Object.keys(TS_HINTS)) assert.ok(key in TS_FIELD_LABELS, key);
});

test('підказки реквізитів і документів відповідають ключам форм', () => {
    const req = read('src/views/docs-requisites.js');
    for (const key of Object.keys(REQUISITES_HINTS)) assert.match(req, new RegExp("key: '" + key + "'"), key);
    const other = read('src/views/docs-other.js');
    for (const key of Object.keys(OTHER_HINTS)) assert.match(other, new RegExp("'kpo-" + key + "'"), key);
    const doc = read('src/views/docs-form.js');
    for (const key of Object.keys(DOC_HINTS)) assert.match(doc, new RegExp('DOC_HINTS[.]' + key + '(?![a-z_])'), key);
    const rep = read('src/views/repairs-form.js');
    for (const key of Object.keys(REPAIR_HINTS)) assert.match(rep, new RegExp('REPAIR_HINTS[.]' + key + '(?![a-z_])'), key);
});

test('картки авто, причепа й водія: «?» через спільний cardField; кожна форма бере field-hint, без власних копій', () => {
    assert.ok(VEHICLE_FIELDS.filter((s) => s.hint).length >= 15);
    assert.ok(TRAILER_FIELDS.filter((s) => s.hint).length >= 5);
    assert.ok(DRIVER_FIELDS.some((s) => s.key === 'license_no' && s.hint));
    assert.match(read('src/views/registry.js'), /labelHint\(.*spec\.hint\)/);
    for (const f of ['docs-form', 'docs-ts-form', 'repairs-form', 'docs-requisites', 'docs-other', 'registry']) {
        const src = read('src/views/' + f + '.js');
        assert.match(src, /from '\.\.\/lib\/field-hint\.js'/, f);
        assert.doesNotMatch(src, /innerHTML/, f);
    }
    assert.doesNotMatch(read('src/lib/field-hint.js'), /innerHTML/);
});
