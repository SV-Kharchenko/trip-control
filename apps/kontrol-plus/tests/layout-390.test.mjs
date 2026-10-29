import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/crm.css', import.meta.url), 'utf8');
const block = css.slice(css.indexOf('/* ===== 390 px'));

test('390 px: the CRM section and its children may shrink (min-width: 0), only .table-wrap scrolls sideways', () => {
    assert.match(block, /#kp-crm, body\[data-kp-view\] #kp-crm \{[^}]*min-width: 0; max-width: 100%/);
    assert.match(block, /#kp-crm > \*, #kp-crm \.card[^{]*\{[^}]*min-width: 0/);
    assert.match(block, /#kp-crm \.table-wrap \{[^}]*overflow-x: auto/);
    assert.match(block, /body\.kp-nav-on #main-app \{ min-width: 0; \}/);
    assert.equal(/overflow-x:\s*(auto|scroll)/.test(block.replace(/#kp-crm \.table-wrap \{[^}]*\}/, '')), false, 'nothing else scrolls');
});

test('buttons are content-sized everywhere in the CRM: full width only through .btn-block', () => {
    assert.equal(/#kp-crm [^{}]*\.btn\b[^{}]*\{[^}]*(?<![-\w])width:\s*100%/.test(css.replace(/#kp-crm \.btn-block \{[^}]*\}/, '')), false);
    assert.match(css, /#kp-crm \.kpk-row \.actions > \.btn[^{]*\{[^}]*flex: 0 0 auto; width: auto/);
});
