import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function buildOnePage');
const build = html.slice(start, start + 20000);

test('п.11: порядок Звідки–Куди → Подача → «Розрахувати відстань» → числа', () => {
    const ab = build.indexOf("opCell('tc-f-a', 'Звідки'");
    const podacha = build.indexOf("opCell('tc-f-podacha'");
    const tools = build.indexOf('panel1.appendChild(routeTools)');
    const nums = build.indexOf("opGroup('nums'");
    assert.ok(ab > 0 && ab < podacha && podacha < tools && tools < nums, 'порядок блоків у panel1');
    assert.match(html, /id="route-calc-btn"[^>]*>Розрахувати відстань</);
});

test('п.12: підпис «ТЗ (транспортний засіб)» замість «Фура»', () => {
    assert.match(build, /opCell\('tc-f-truck', 'ТЗ \(транспортний засіб\)'/);
    assert.match(build, /truckLab\.textContent = 'ТЗ \(транспортний засіб\)'/);
    assert.equal(/opCell\('tc-f-truck', 'Фура'/.test(build), false);
});
