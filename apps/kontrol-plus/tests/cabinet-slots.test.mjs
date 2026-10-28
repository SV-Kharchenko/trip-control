import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { slotCss, SLOT } from '../scripts/gen-slot-css.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const site = fs.readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

test('cabinet-slot.css is generated from crm.css (run npm run gen:slot-css when crm.css changes)', () => {
    assert.equal(read('src/cabinet-slot.css'), slotCss(read('src/crm.css')));
});

test('slot styles: the same rules for #cabinet-screen .cab-slot, nothing about the side menu or the site page', () => {
    const css = read('src/cabinet-slot.css');
    assert.ok(css.includes(SLOT + ' .kpr-req .form .field'), 'requisites form rows');
    assert.ok(css.includes(SLOT + ' .kps-tiles'), 'statistics tiles');
    assert.equal(/#kp-crm/.test(css), false, 'no leftover #kp-crm');
    assert.equal(/#main-app|#kp-side|#kp-toast|kp-nav|data-kp-view|#sticky-top/.test(css), false);
    assert.equal(new RegExp(SLOT.replace(/[.#]/g, '\\$&') + ' \\{ display: none; \\}').test(css), false, 'the slot is never hidden by the root rule');
    // Палітра слота і темна тема — ті самі змінні, що й у розділів Контроль+.
    assert.ok(css.includes('body[data-theme="dark"] ' + SLOT));
    assert.match(css, /@media \(max-width: 560px\) \{/);
});

test('the bridge fills the cabinet slots on tc:cabinet-tab; the side menu no longer has Requisites / Statistics', () => {
    const bridge = read('src/bridge.js');
    assert.match(bridge, /window\.addEventListener\('tc:cabinet-tab', onCabinetTab\)/);
    assert.match(bridge, /SLOT_IDS = \{ requisites: 'cab-req-slot', stats: 'cab-stats-slot' \}/);
    assert.match(bridge, /renderCabinetRequisites\(app\(\)\)/);
    assert.match(bridge, /renderStats\(app\(\)\)/);
    assert.match(bridge, /crmAccess\(state\.context\) !== 'open'/, 'no Контроль+ plan → a notice instead of the screen');
    assert.equal(/go\('#\/(stats|company)'\)/.test(bridge), false);
    assert.match(read('src/site-bridge.js'), /import '\.\/cabinet-slot\.css';/);
});

test('the site has the slot ids, the event and the old-URL redirects the bridge relies on', () => {
    assert.match(site, /id="cab-req-slot"/);
    assert.match(site, /id="cab-stats-slot"/);
    assert.match(site, /new CustomEvent\('tc:cabinet-tab'/);
    assert.match(site, /'#\/company': 'requisites'/);
    assert.match(site, /'#\/docs\/requisites': 'requisites'/);
    assert.match(site, /'#\/stats': 'stats'/);
    assert.match(site, /'#\/team': 'team'/);
});

test('documents / act forms: no full-width buttons (the site .btn is content-sized now, nothing overrides it to stretch)', () => {
    for (const file of fs.readdirSync(new URL('../src/views/', import.meta.url)).filter((f) => /^docs.*\.js$/.test(f))) {
        const src = read('src/views/' + file);
        assert.equal(/btn-block|width:\s*100%/.test(src), false, file);
    }
    const css = read('src/crm.css');
    assert.equal(/#kp-crm [^{]*\.btn\b[^{]*\{[^}]*(flex: 1|width: 100%)/.test(css.replace(/#kp-crm \.btn-block \{ width: 100%; \}/, '')), false);
});
