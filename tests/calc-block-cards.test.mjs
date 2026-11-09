// Блоки калькулятора («Назва / маршрут», «Пальне», «Додаткові параметри», «Останні маршрути») — окремі картки із золотою смужкою; кольори з токенів тем.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = html.slice(html.indexOf('/* Блоки калькулятора («Назва / маршрут»'), html.lastIndexOf('</style>'));

test('картка: фон поверхні, рамка 1px, радіус 12px, тінь, відступ між картками 11px', () => {
    assert.match(block, /#tc-op \.tc-acc-row \{[^}]*background-color: var\(--surface\); border: 1px solid var\(--border\); border-radius: 12px; box-shadow: var\(--blk-shadow\)/);
    assert.match(block, /#tc-op > \.tc-acc \{ gap: 11px;/);
});

test('золота смужка 4px на всю висоту, шапка із заливкою, рамка під шапкою лише у розгорнутому стані, кружечок із золота', () => {
    assert.match(block, /\.tc-acc-row::before \{[^}]*width: 4px;[^}]*background: var\(--gold\)/);
    assert.match(block, /\.tc-acc-head \{[^}]*background: var\(--blk-head-bg\)/);
    assert.match(block, /\.tc-acc-row\.is-open > \.tc-acc-head \{[^}]*border-bottom: 1px solid var\(--border-soft\)/);
    assert.match(block, /\.tc-acc-name \{ font-weight: 700; color: var\(--blk-title\)/);
    assert.match(block, /\.tc-acc-n \{[^}]*border-radius: 50%; background: var\(--gold\); color: var\(--blk-n-ink\)/);
});

test('кольори лише з токенів тем: у блоці немає hex, обидві теми мають токени', () => {
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block.replace(/rgba?\([^)]*\)/g, '')), false);
    for (const theme of ['light', 'dark']) {
        const start = html.indexOf('[data-theme="' + theme + '"] {');
        const tokens = html.slice(start, html.indexOf('}', start));
        for (const t of ['--blk-head-bg', '--blk-title', '--blk-n-ink', '--blk-shadow']) assert.ok(tokens.includes(t + ':'), theme + ' ' + t);
    }
});

test('висота не росте: без верхнього відступу над першою карткою (компактний режим і демо 14″)', () => {
    assert.match(block, /#tc-op > \.tc-acc \{ gap: 11px; padding-top: 0; \}/);
});
