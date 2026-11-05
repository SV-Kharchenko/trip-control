// Контроль+: конфігурація середовища (staging / прод) і запасний вимикач модулів. Копія lib/public-config.js ідентична кореневій,
// /api/config — власний статичний файл проєкту, збірка зберігає блокувальний <script src="/api/config">, без зашитих ключів і адрес бази.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectSite } from '../scripts/site-html.mjs';
import { buildPublicConfig, createConfigHandler, renderConfigScript, sessionStorageKey } from '../lib/public-config.js';
import { featureDisabled } from '../src/lib/features.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const PROD_URL = 'https://qkfqjorzsxcajcneohoy.supabase.co';
const ENV = { SUPABASE_URL: PROD_URL, SUPABASE_ANON_KEY: 'sb_publishable_TestOnlyFakeKey0123456789', VERCEL_ENV: 'production' };

test('копія конфігу в Контроль+ ідентична кореневій; /api/config — статичний файл проєкту', () => {
    assert.equal(read('lib/public-config.js'), fs.readFileSync(path.join(APP, '../../lib/public-config.js'), 'utf8'));
    assert.match(read('api/config.js'), /createConfigHandler\(\)/);
});

test('без env — явна помилка, не прод; прод-env дає ті самі URL й ключ сесії', () => {
    assert.equal(buildPublicConfig({}).ok, false);
    const out = buildPublicConfig(ENV);
    assert.equal(out.config.supabaseUrl, PROD_URL);
    assert.equal(sessionStorageKey(out.config.supabaseUrl), 'sb-qkfqjorzsxcajcneohoy-auth-token');
    assert.equal(renderConfigScript(out.config).includes('STAGING'), false, 'на проді бейджа немає');
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send() { return this; } };
    createConfigHandler(() => ({}), { error() {} })({ method: 'GET' }, res);
    assert.equal(res.code, 503);
});

test('збірка: сайт у Контроль+ має блокувальний /api/config перед Supabase, без зашитої адреси чи ключа', () => {
    const html = injectSite(fs.readFileSync(path.join(APP, '../../index.html'), 'utf8'), { js: '/kp-assets/x.js' });
    assert.equal(html.includes('qkfqjorzsxcajcneohoy'), false);
    assert.doesNotMatch(html, /sb_publishable_|sb_secret_/);
    const config = html.indexOf('<script src="/api/config"></script>');
    assert.ok(config > 0 && config < html.indexOf('cdn.jsdelivr.net/npm/@supabase/supabase-js'));
});

test('запасний вимикач на фронті: featureDisabled читає window.TC_CONFIG.disabledFeatures', () => {
    assert.equal(featureDisabled('own_fleet', { disabledFeatures: ['own_fleet'] }), true);
    assert.equal(featureDisabled('OWN_FLEET', { disabledFeatures: ['own_fleet'] }), true);
    assert.equal(featureDisabled('gps', { disabledFeatures: ['own_fleet'] }), false);
    assert.equal(featureDisabled('own_fleet', {}), false);
    assert.equal(featureDisabled('own_fleet', null), false);
    assert.equal(featureDisabled('own_fleet'), false, 'без window і без конфігу — не вимкнено (вимикач лише додатковий)');
    const cfg = buildPublicConfig({ ...ENV, KP_DISABLED_FEATURES: 'own_fleet,gps' }).config;
    assert.equal(featureDisabled('own_fleet', cfg), true, 'env → конфіг → фронт');
    assert.equal(featureDisabled('repairs', cfg), false);
});
