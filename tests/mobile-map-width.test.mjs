// Мобільний калькулятор: карта на всю ширину (колонка flex не повинна успадковувати align-items: start з десктопної сітки).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('≤900px, calc без «Детально»: колонки та карта розтягуються на 100%', () => {
    const start = html.indexOf('/* ≤900: смуга (2 колонки KPI)');
    assert.notEqual(start, -1);
    const block = html.slice(start, html.indexOf('\n        }\n', start));
    const sel = 'body.layout-studio[data-studio-view="calc"]:not([data-calc-detail="1"])';
    const rule = (s) => {
        const at = block.indexOf('            ' + sel + ' ' + s + ' {');
        assert.notEqual(at, -1, s);
        return block.slice(at, block.indexOf('}', at));
    };
    const cols = rule('#studio-columns');
    assert.match(cols, /flex-direction: column/);
    assert.match(cols, /align-items: stretch/);
    assert.match(cols, /width: 100%/);
    const right = rule('#studio-right');
    assert.match(right, /align-self: stretch/);
    assert.doesNotMatch(right, /align-self: auto/);
    assert.match(right, /width: 100%; max-width: 100%/);
    assert.match(right, /order: -1/);
    const frame = rule('#studio-right > .tc-map-frame');
    assert.match(frame, /width: 100%/);
    assert.match(frame, /height: 260px !important/);
});
