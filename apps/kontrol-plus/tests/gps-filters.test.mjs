// GPS #/gps: фільтри таблиці «Юніти й авто», пошук з латиниця/кирилиця-двійниками, збереження в localStorage окремо від карти,
// випадні списки над картою (z-index, без обрізання), одна висота керування в рядку, ліміт api/ = 12. Без браузера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SELECTION_KEY, TABLE_FILTER_KEY, tableCountText, emptyTableFilters, filterUnitRows, loadSelection, loadTableFilters, normKey, pruneTableFilters, saveSelection,
    saveTableFilters, searchUnits, tableFiltersActive,
} from '../src/lib/gps-catalog.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8').replace(/\r\n/g, '\n');

const UNITS = [
    { id: 'u1', name: 'AA 2008 EA_DAF', vehicle_id: 'v1', vehicle_label: 'AA2008EA DAF', kind: 'truck' },
    { id: 'u2', name: 'John Deere 8R', vehicle_id: null, vehicle_label: null, kind: 'tractor' },
    { id: 'u3', name: 'Бус без типу', vehicle_id: null, vehicle_label: null, kind: null },
    { id: 'u4', name: 'КА 1234 ВС Мерседес', vehicle_id: 'v4', vehicle_label: 'КА1234ВС', kind: null },
    { id: 'u5', name: 'Спецтехніка', vehicle_id: null, vehicle_label: null, kind: 'special' },
];
const MEMBERS = { u1: ['g1'], u2: ['g1', 'g2'], u4: ['g2'] };
const ids = (rows) => rows.map((u) => u.id);
const F = (patch) => ({ ...emptyTableFilters(), ...patch });

test('normKey: регістр, пробіли, «_», «-», «.» і двійники А/A В/B Е/E І/I К/K М/M Н/H О/O Р/P С/C Т/T Х/X', () => {
    assert.equal(normKey('АА2008ЕА'), normKey('AA 2008 EA'));
    assert.equal(normKey('ВІ 7777 КХ'), normKey('bi_7777-kx'));
    for (const [cyr, lat] of [['А', 'A'], ['В', 'B'], ['Е', 'E'], ['І', 'I'], ['К', 'K'], ['М', 'M'], ['Н', 'H'], ['О', 'O'], ['Р', 'P'], ['С', 'C'], ['Т', 'T'], ['Х', 'X']]) {
        assert.equal(normKey(cyr), normKey(lat), cyr + ' = ' + lat);
        assert.equal(normKey(cyr.toLowerCase()), normKey(lat.toLowerCase()));
    }
    assert.equal(normKey(null), '');
});

test('фільтр таблиці: за номером — «АА2008ЕА» (кирилиця) знаходить «AA 2008 EA» (латиниця) і навпаки; за номером прив’язаного авто теж', () => {
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ q: 'АА2008ЕА' }), MEMBERS)), ['u1']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ q: 'ka1234bc' }), MEMBERS)), ['u4'], 'латиниця знаходить кириличну назву');
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ q: ' aa_2008-ea ' }), MEMBERS)), ['u1'], 'пробіли, «_» і «-» не заважають');
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ q: 'john' }), MEMBERS)), ['u2'], 'регістр не важливий');
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ q: '   ' }), MEMBERS)), ids(UNITS), 'порожній пошук — усі');
    // Пошук карти використовує ту саму нормалізацію.
    assert.deepEqual(searchUnits(UNITS.map((u) => ({ ...u, active: true })), 'АА2008ЕА').map((u) => u.id), ['u1']);
});

test('фільтр таблиці: група, тип (включно з «Не визначено»), прив’язка, комбінації', () => {
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ groupIds: ['g1'] }), MEMBERS)), ['u1', 'u2']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ groupIds: ['g1', 'g2'] }), MEMBERS)), ['u1', 'u2', 'u4'], 'кілька груп — «або»');
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ kinds: ['truck'] }), MEMBERS)), ['u1']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ kinds: ['none'] }), MEMBERS)), ['u3', 'u4'], '«Не визначено» = kind null');
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ kinds: ['none', 'special'] }), MEMBERS)), ['u3', 'u4', 'u5']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ link: 'linked' }), MEMBERS)), ['u1', 'u4']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ link: 'unlinked' }), MEMBERS)), ['u2', 'u3', 'u5']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ groupIds: ['g2'], link: 'linked' }), MEMBERS)), ['u4']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ groupIds: ['g1'], kinds: ['tractor'], q: 'deere' }), MEMBERS)), ['u2']);
    assert.deepEqual(ids(filterUnitRows(UNITS, F({ groupIds: ['g-none'] }), MEMBERS)), []);
});

test('лічильник і скидання: «Показано N з M» рахується від довжини результату; скинутий фільтр повертає всі юніти', () => {
    const f = F({ kinds: ['none'], link: 'linked' });
    assert.equal(tableFiltersActive(f), true);
    const found = filterUnitRows(UNITS, f, MEMBERS).length;
    assert.equal(tableCountText(found, found, UNITS.length), 'Знайдено 1 з 5');
    assert.equal(tableCountText(721, 721, 721), 'Показано 721', 'без фільтрів і все видно');
    assert.equal(tableCountText(500, 200, 721), 'Знайдено 500 з 721 · показано 200');
    assert.equal(tableCountText(721, 200, 721), 'Знайдено 721 з 721 · показано 200', 'без фільтрів, але видно не всі');
    assert.equal(tableCountText(0, 0, 721), 'Знайдено 0 з 721');
    const reset = emptyTableFilters();
    assert.equal(tableFiltersActive(reset), false);
    assert.equal(filterUnitRows(UNITS, reset, MEMBERS).length, UNITS.length);
});

test('localStorage: фільтри таблиці окремо від вибору карти, по організаціях; сміття відсікається; зниклі групи прибираються', () => {
    const mem = new Map();
    const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
    const f = F({ groupIds: ['g1', 'g2'], kinds: ['truck', 'none'], q: 'AA 2008', link: 'unlinked' });
    saveTableFilters('org1', f, store);
    saveSelection('org1', { all: false, groupIds: ['g9'], unitIds: [], kinds: [] }, store);
    assert.deepEqual([...mem.keys()].sort(), [TABLE_FILTER_KEY + ':org1', SELECTION_KEY + ':org1'].sort(), 'два різні ключі');
    assert.notEqual(TABLE_FILTER_KEY, SELECTION_KEY);
    assert.deepEqual(loadTableFilters('org1', store), f);
    assert.deepEqual(loadSelection('org1', store).groupIds, ['g9'], 'вибір карти не зачеплено');
    assert.deepEqual(loadTableFilters('org2', store), emptyTableFilters(), 'інша організація — порожньо');
    mem.set(TABLE_FILTER_KEY + ':org3', JSON.stringify({ groupIds: [1, 'g1'], kinds: ['truck', 'rocket'], q: 'x'.repeat(200), link: 'weird' }));
    assert.deepEqual(loadTableFilters('org3', store), { groupIds: ['g1'], kinds: ['truck'], q: 'x'.repeat(60), link: 'all' });
    mem.set(TABLE_FILTER_KEY + ':org4', '{not json');
    assert.deepEqual(loadTableFilters('org4', store), emptyTableFilters());
    assert.deepEqual(pruneTableFilters(f, { groups: [{ id: 'g2' }] }).groupIds, ['g2']);
    assert.doesNotThrow(() => saveTableFilters('org1', f, { setItem() { throw new Error('quota'); } }));
});

test('випадні списки: z-index вищий за Leaflet (до 1000), карта — окремий контекст накладання, предки не обрізають', () => {
    const css = read('src/crm.css');
    const rule = (sel) => (css.match(new RegExp('^#kp-crm ' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*\\}', 'm')) || [''])[0];
    const vars = css.match(/--gps-pop-z:\s*(\d+)/);
    assert.ok(vars && Number(vars[1]) > 1000, '--gps-pop-z > 1000');
    for (const sel of ['.gps-multi-list', '.gps-unit-results']) assert.match(rule(sel), /z-index: var\(--gps-pop-z/, sel + ' бере z-index із змінної');
    assert.doesNotMatch(css, /\.gps-(multi-list|unit-results)[^{]*\{[^}]*z-index: ?\d{1,3}[;\s}]/, 'жодних «зашитих» z-index ≤ 999 у списках');
    assert.match(rule('.gps-map'), /isolation: isolate/, 'панелі Leaflet лишаються всередині карти');
    assert.match(rule('.gps-map'), /z-index: 0/);
    assert.match(css, /#kp-crm \.gps-filter, #kp-crm \.gps-tfilter \{[^}]*position: relative; z-index: var\(--gps-pop-z\)/, 'рядок фільтрів — над картою');
    assert.match(css, /#kp-crm \.gps-page \{[^}]*isolation: isolate/, 'сторінка GPS не виходить над шапкою оболонки');
    // Батьки випадних списків не мають overflow, який обрізає: рядок фільтрів, картка, секція.
    for (const sel of ['.gps-filter', '.gps-tfilter', '.gps-filter-row', '.gps-multi', '.gps-unit-pick', '.gps-map-section', '.gps-page']) {
        assert.doesNotMatch(rule(sel) + (css.match(new RegExp('^#kp-crm ' + sel.replace('.', '\\.') + ', [^{]*\\{[^}]*\\}', 'm')) || [''])[0], /overflow(-x|-y)?: ?(hidden|auto|scroll|clip)/, sel + ' не обрізає');
    }
});

test('висота поля пошуку = висота кнопок рядка: одна змінна --gps-ctl-h', () => {
    const css = read('src/crm.css');
    assert.match(css, /--gps-ctl-h: \d+px/);
    const shared = css.match(/#kp-crm \.gps-filter \.btn, #kp-crm \.gps-tfilter \.btn, #kp-crm \.gps-multi > summary, #kp-crm \.gps-unit-search, #kp-crm \.gps-tfilter select \{[^}]*\}/);
    assert.ok(shared, 'одне правило для кнопок, summary, поля пошуку й select');
    assert.match(shared[0], /height: var\(--gps-ctl-h\)/);
    assert.match(shared[0], /min-height: var\(--gps-ctl-h\)/);
    assert.match(css, /#kp-crm \.gps-filter-row \{[^}]*align-items: center/, 'вирівнювання по центру');
    assert.doesNotMatch(css, /\.gps-unit-search \{[^}]*min-height: 30px/, 'власної висоти у поля пошуку більше немає');
    // Поле пошуку не на всю ширину; кнопки — за вмістом.
    assert.match(css, /\.gps-unit-pick \{[^}]*width: 260px/);
    assert.match(css, /\.gps-filter \.btn[^{]*\{[^}]*width: auto/);
});

test('вікна й слоти отримали ті самі правила (згенеровані з crm.css)', () => {
    for (const file of ['src/cabinet-slot.css', 'src/kp-win-scope.css']) {
        const css = read(file);
        assert.match(css, /--gps-pop-z: 1100/, file);
        assert.match(css, /--gps-ctl-h/, file);
    }
});

test('таблиця: фільтри підключені, пошук із debounce 200 мс, «Показати ще» по 200, після sync і зміни типу каталог карти перечитується', () => {
    const view = read('src/views/gps.js');
    assert.match(view, /setTimeout\(\(\) => setTableFilters\(\{ q: tSearch\.value \}\), 200\)/);
    assert.match(view, /TABLE_PAGE/);
    assert.match(view, /data-act': 'more'/);
    assert.match(view, /tableCountText\(filtered\.length, visible\.length, units\.length\)/);
    assert.match(view, /groupsPending/);
    assert.match(view, /'Завантаження груп…'/);
    const sync = view.slice(view.indexOf("run('Оновити список юнітів'"), view.indexOf("confirmButton('Відключити'"));
    assert.match(sync, /await load\(true\);[\s\S]*mapSection\.reloadCatalog\(\)/, 'після sync-units перечитуємо каталог карти');
    assert.match(view, /toast\(event\.currentTarget\.value \? 'Тип збережено вручну'[\s\S]*?mapSection\.reloadCatalog/, 'і після ручної зміни типу');
    const map = read('src/views/gps-map.js');
    assert.match(map, /state\.selection = pruned/, 'невалідний вибір прибирається через pruneSelection');
    assert.match(map, /onCatalog\(catalog\)/);
});

test('api/ Контроль+: рівно 12 функцій', () => {
    const files = fs.readdirSync(path.join(APP, 'api'), { recursive: true }).map((f) => String(f).split(String.fromCharCode(92)).join('/')).filter((f) => /\.(js|mjs|cjs|ts)$/.test(f));
    assert.equal(files.length, 12, files.join(', '));
});

test('двійники латиниці й кирилиці: усі 13 пар, зокрема Y/У; «AY1234XY» знаходить «АУ1234ХУ»', () => {
    const pairs = [['A', 'А'], ['B', 'В'], ['C', 'С'], ['E', 'Е'], ['H', 'Н'], ['I', 'І'], ['K', 'К'], ['M', 'М'], ['O', 'О'], ['P', 'Р'], ['T', 'Т'], ['X', 'Х'], ['Y', 'У']];
    for (const [lat, cyr] of pairs) {
        assert.equal(normKey(lat), normKey(cyr), lat + ' = ' + cyr);
        assert.equal(normKey(lat.toLowerCase()), normKey(cyr.toLowerCase()));
        assert.equal(normKey(lat), normKey(cyr.toLowerCase()), 'регістр не важливий');
    }
    const units = [{ id: 'y1', name: 'АУ1234ХУ Скания', vehicle_id: null, vehicle_label: null, kind: null, active: true }, { id: 'y2', name: 'ВС0000ВС', vehicle_id: null, vehicle_label: null, kind: null, active: true }];
    assert.deepEqual(filterUnitRows(units, { ...emptyTableFilters(), q: 'AY1234XY' }, {}).map((u) => u.id), ['y1']);
    assert.deepEqual(filterUnitRows(units, { ...emptyTableFilters(), q: 'ау 1234 ху' }, {}).map((u) => u.id), ['y1']);
    assert.deepEqual(searchUnits(units, 'ay1234xy').map((u) => u.id), ['y1'], 'пошук карти теж');
    assert.deepEqual(filterUnitRows([{ id: 'y3', name: 'AY1234XY', vehicle_id: 'v', vehicle_label: 'AY 1234 XY' }], { ...emptyTableFilters(), q: 'АУ1234ХУ' }, {}).map((u) => u.id), ['y3'], 'навпаки');
});
