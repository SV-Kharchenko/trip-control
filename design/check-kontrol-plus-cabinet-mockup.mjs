// Перевірка макета без браузера: парсить design/kontrol-plus-cabinet-mockup.html і шукає меню та секції.
// node design/check-kontrol-plus-cabinet-mockup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./kontrol-plus-cabinet-mockup.html', import.meta.url), 'utf8');

// Теги, що парсяться: стек відкритих/закритих елементів має зійтися (void-елементи пропускаємо).
const VOID = new Set(['meta', 'input', 'br', 'hr', 'img', 'link', 'path', 'rect', 'polyline', 'circle']);
const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '<script></script>').replace(/<style[\s\S]*?<\/style>/g, '<style></style>');
const stack = [];
for (const m of body.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const name = m[1].toLowerCase();
    if (VOID.has(name) || m[2] === '/') continue;
    if (m[0].startsWith('</')) assert.equal(stack.pop(), name, 'unbalanced </' + name + '>');
    else stack.push(name);
}
assert.deepEqual(stack, [], 'unclosed tags: ' + stack.join(','));

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length, 'duplicate ids');

const menu = [...html.matchAll(/<button type="button" data-s="([a-z]+)"[^>]*><span class="ic"[^>]*>[^<]*<\/span><span class="lb">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
assert.deepEqual(menu, [
    ['overview', 'Огляд'], ['calc', 'Розрахунки'], ['fleet', 'Автопарк'], ['drivers', 'Водії'],
    ['docs', 'Документи'], ['planfact', 'План/факт'], ['stats', 'Статистика компанії'], ['company', 'Реквізити компанії'],
]);
for (const [key] of menu) assert.ok(ids.includes('s-' + key), 'section s-' + key);

const need = [
    'fl-cars', 'fl-trailers', 'plate', 'plates', 'drivers', 'dc-contracts', 'dc-ttn', 'dc-acts', 'dc-other', 'pf-main', 'pf-debts',
];
for (const id of need) assert.ok(ids.includes(id), id);
for (const text of ['Авто', 'Причепи', 'Договори', 'ТТН / 2-ТН', 'Акти', 'Інше', 'Борги', 'Експорт CSV', 'Зберегти', 'Картка водія', 'Закріплене авто']) {
    assert.ok(html.includes('>' + text + '<'), text);
}
for (const col of ['Номер', 'Марка / модель', 'Тип', 'Стан', 'Пробіг', 'Найближче ТО']) assert.ok(html.includes('<th>' + col + '</th>') || html.includes('<th class="n">' + col + '</th>'), col);
for (const group of ['Основне', 'Адреси', 'Банк', 'Контакти']) assert.ok(html.includes('<h4>' + group + '</h4>'), group);
for (const label of ['Назва', 'ЄДРПОУ / ІПН', 'Платник ПДВ', 'Юридична', 'Фактична', 'IBAN', 'Банк', 'МФО', 'Телефон', 'Email', 'Підписант', 'Посада']) assert.ok(html.includes('<span>' + label + '</span>'), label);
assert.match(html, /\.form\{max-width:760px;margin-inline:auto\}/);
assert.match(html, /@media\(max-width:1024px\)\{\s*:root\{--nav:64px\}/);
assert.equal((html.match(/<svg viewBox/g) || []).length, 2, 'two inline charts');
assert.equal(/https?:\/\//.test(html.replace(/\.example/g, '')), false, 'no external dependencies');
assert.match(html, /data-theme="light"/);
assert.match(html, /\[data-theme=dark\]/);
console.log('OK: меню (8), секції, підвкладки, таблиці, форма реквізитів, 2 графіки, Dark/Light — без зовнішніх залежностей.');
