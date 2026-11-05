// Кабінет суперадміна: чисті функції, маршрут і статичні гарантії (працюють і без браузера).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCrmHash, tabOf } from '../src/lib/route.js';
import { SHELL_ITEMS } from '../src/shell-menu.js';
import { auditValue, featureOn, orgModuleNote, settingRows, settingState, superadminErrorText } from '../src/lib/superadmin.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

test('маршрут #/superadmin і пункт меню «Платформа»', () => {
    assert.deepEqual(parseCrmHash('#/superadmin'), { view: 'superadmin' });
    assert.equal(parseCrmHash('#/superadmin/x'), null);
    assert.equal(tabOf({ view: 'superadmin' }), 'superadmin');
    const item = SHELL_ITEMS.find((i) => i.key === 'superadmin');
    assert.equal(item.label, 'Платформа');
    assert.equal(item.access, 'superadmin', 'видимість — за прихованою кнопкою kp-nav-superadmin, яку показує лише суперадмін');
});

test('стан перемикача: немає рядка = вимкнено й показано окремо; невідомі ключі теж у списку', () => {
    assert.equal(settingState(null), 'missing');
    assert.equal(settingState({ enabled: false }), 'off');
    assert.equal(settingState({ enabled: true }), 'on');
    assert.deepEqual(settingRows([]).map((r) => [r.key, r.state]), [['own_fleet', 'missing']]);
    assert.deepEqual(settingRows([{ key: 'zeta', enabled: true }, { key: 'own_fleet', enabled: true }]).map((r) => [r.key, r.state]), [['own_fleet', 'on'], ['zeta', 'on']]);
});

test('підказка для компанії та текст журналу', () => {
    assert.equal(orgModuleNote(true, 'off'), 'Не працює, бо вимкнено глобально.');
    assert.equal(orgModuleNote(true, 'missing'), 'Не працює, бо вимкнено глобально.');
    assert.equal(orgModuleNote(true, 'on'), '');
    assert.equal(orgModuleNote(false, 'off'), '');
    assert.equal(auditValue({ enabled: false }), 'вимкнено');
    assert.equal(auditValue({ own_fleet: true }), 'увімкнено');
    assert.equal(auditValue(null), '—');
    assert.match(superadminErrorText({ message: 'SUPERADMIN_REQUIRED' }), /лише для адміністраторів/);
    assert.match(superadminErrorText({ message: 'boom' }), /Не вдалося/);
});

test('сторінка: лише sa_* RPC, без confirm / alert, підтвердження через tcModal, аудит по 50', () => {
    const view = read('src/views/superadmin/index.js');
    assert.equal(/\b(window\.)?(confirm|alert|prompt)\(/.test(view), false);
    assert.match(view, /window\.tcModal/);
    assert.deepEqual([...new Set([...view.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]))].sort(),
        ['sa_create_setting', 'sa_list_audit', 'sa_list_settings', 'sa_search_orgs', 'sa_set_org_feature', 'sa_set_setting']);
    assert.equal(/\.from\(/.test(view), false, 'таблиць напряму не читаємо');
    assert.match(read('src/lib/superadmin.js'), /AUDIT_PAGE = 50/);
});

test('bridge: сторінка вантажиться lazy і лише для суперадміна (редирект на огляд)', () => {
    const bridge = read('src/bridge.js');
    assert.match(bridge, /route\.view === 'superadmin'[\s\S]*?if \(!state\.superadmin\)[\s\S]*?location\.hash = '#\/dashboard'[\s\S]*?import\('\.\/views\/superadmin\/index\.js'\)/);
    assert.match(bridge, /rpc\('is_platform_superadmin'\)/);
});

test('featureOn: true або рядок "true" — як features ->> key у базі', () => {
    assert.equal(featureOn({ own_fleet: true }, 'own_fleet'), true);
    assert.equal(featureOn({ own_fleet: 'true' }, 'own_fleet'), true);
    for (const v of [false, 'false', 'TRUE', 1, null, undefined, 'yes']) assert.equal(featureOn({ own_fleet: v }, 'own_fleet'), false, String(v));
    assert.equal(featureOn(null, 'own_fleet'), false);
    assert.equal(featureOn({}, 'own_fleet'), false);
});
