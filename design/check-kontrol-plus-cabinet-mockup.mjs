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

const menu = [...html.matchAll(/<button type="button" data-s="([a-z]+)"[^>]*><span class="ic"[^>]*><svg[\s\S]*?<\/svg><\/span><span class="lb">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
assert.deepEqual(menu, [
    ['overview', 'Огляд'], ['calc', 'Розрахунки'], ['fleet', 'Автопарк'], ['drivers', 'Водії'],
    ['docs', 'Документи'], ['planfact', 'План/факт'], ['stats', 'Статистика'], ['company', 'Реквізити компанії'],
]);
for (const [key] of menu) assert.ok(ids.includes('s-' + key), 'section s-' + key);

const need = [
    'fl-cars', 'fl-trailers', 'plate', 'drivers', 'dc-contracts', 'dc-ttn', 'dc-acts', 'dc-other', 'pf-main', 'pf-debts',
];
for (const id of need) assert.ok(ids.includes(id), id);
for (const text of ['Авто', 'Причепи', 'Договори', 'ТТН / 2-ТН', 'Акти', 'Інше', 'Борги', 'Експорт CSV', 'Зберегти', 'Картка водія', 'Закріплене авто']) {
    assert.ok(html.includes('>' + text + '<'), text);
}
for (const col of ['Номер', 'Марка / модель', 'Тип', 'Стан', 'Пробіг', 'Найближче ТО']) assert.ok(html.includes('<th>' + col + '</th>') || html.includes('<th class="n">' + col + '</th>'), col);
for (const group of ['Основне', 'Адреси', 'Банк', 'Контакти']) assert.ok(html.includes('<h4>' + group + '</h4>'), group);
for (const label of ['Назва', 'ЄДРПОУ / ІПН', 'Платник ПДВ', 'Юридична', 'Фактична', 'IBAN', 'Банк', 'МФО', 'Телефон', 'Email', 'Підписант', 'Посада']) assert.ok(html.includes('<span>' + label + '</span>'), label);
assert.match(html, /\.form\{max-width:640px;margin-inline:auto\}/);
assert.match(html, /\.form \.ir\{display:grid;grid-template-columns:160px auto;justify-content:start;align-items:center;gap:12px\}/);
const company = html.slice(html.indexOf('<section class="sec" id="s-company"'), html.indexOf('</section>', html.indexOf('<section class="sec" id="s-company"')));
assert.equal(/margin-left:auto|space-between/.test(company), false, 'no margin-left:auto / space-between inside #s-company');
assert.equal((company.match(/<div class="ir">/g) || []).length, 13, 'company rows');
const formCss = html.slice(html.indexOf('.form .ir{'), html.indexOf('}', html.indexOf('.form .ir{')));
assert.equal(/margin-left:auto|space-between/.test(formCss), false, 'form rows css');
const navHtml = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>'));
assert.equal((navHtml.match(/<span class="ic" aria-hidden="true"><svg /g) || []).length, 8, 'menu icons are inline svg');
assert.equal(/[▦∑⛟☺▤⇄◔☰]/.test(navHtml), false, 'no font glyph icons');
assert.equal((html.match(/<h1 id="h-stats">Статистика<\/h1>/g) || []).length, 1);
assert.match(html, /@media\(max-width:1024px\)\{\s*:root\{--nav:64px\}/);
assert.equal((html.match(/<svg viewBox="0 0 400 180"/g) || []).length, 2, 'two inline charts');
assert.equal(/https?:\/\//.test(html.replace(/\.example/g, '')), false, 'no external dependencies');
assert.match(html, /data-theme="light"/);
assert.match(html, /\[data-theme=dark\]/);

// ---- Автопарк: без чіпів, живий фільтр за номером ----
const fleet = html.slice(html.indexOf('<section class="sec" id="s-fleet"'), html.indexOf('</section>', html.indexOf('<section class="sec" id="s-fleet"')));
assert.equal(/class="chip/.test(fleet), false, 'no chips in #s-fleet');
assert.equal(ids.includes('plates'), false, 'no #plates');
assert.match(fleet, /<input id="plate" type="search" placeholder="напр\. 4821"/);
assert.equal((fleet.match(/<tr class="nf" hidden><td colspan="6" class="empty">Нічого не знайдено<\/td><\/tr>/g) || []).length, 2, 'empty row in both tables');
const normSource = html.match(/function normPlate\(s\) \{[\s\S]*?\n  \}/);
assert.ok(normSource, 'normPlate is in the page script');
const normPlate = new Function(normSource[0] + '\nreturn normPlate;')();
assert.equal(normPlate('аа 4821 кт'), normPlate('AA4821KT'));
assert.equal(normPlate('аа 4821 кт'), 'AA4821KT');
assert.equal(normPlate('AA-4821-KT'), 'AA4821KT');
assert.equal(normPlate(null), '');
const plates = [...fleet.matchAll(/<td class="mono">([A-Z]{2} \d{4} [A-Z]{2})<\/td>/g)].map((m) => m[1]);
assert.ok(plates.length >= 6);
const find = (query) => plates.filter((p) => !normPlate(query) || normPlate(p).includes(normPlate(query)));
assert.ok(find('4821').includes('AA 4821 KT'));
assert.ok(find('AA4821').includes('AA 4821 KT'));
assert.ok(find('аа 48').includes('AA 4821 KT'));
assert.deepEqual(find('zzzz'), []);
assert.equal(find('').length, plates.length, 'empty query shows everything');
assert.match(html, /\$\('#plate'\)\.addEventListener\('input', filterPlates\)/);
// ---- Реквізити: телефон 170px, цифрові поля ліворуч ----
const co = html.slice(html.indexOf('<section class="sec" id="s-company"'), html.indexOf('</section>', html.indexOf('<section class="sec" id="s-company"')));
assert.match(html, /\.w-ph\{--w:170px\}/);
assert.match(co, /<span>Телефон<\/span><span class="fld w-ph">/);
assert.equal(/class="r"/.test(co), false, 'no right-aligned inputs in #s-company');
console.log('OK: меню (8), секції, підвкладки, таблиці, форма реквізитів, 2 графіки, Dark/Light — без зовнішніх залежностей.');
