import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name, params) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = html.slice(open + 1, i);
                return new Function(...params, body);
            }
        }
    }
    throw new Error('unclosed ' + name);
}

const historyCsvCell = extractFunction('historyCsvCell', ['value']);
const historyExportHeaders = extractFunction('historyExportHeaders', []);
const historyExportValues = extractFunction('historyExportValues', ['row']);
const historyCsv = extractFunction('historyCsv', ['records']);
const historyExportName = extractFunction('historyExportName', ['from', 'to', 'ext']);
globalThis.historyCsvCell = historyCsvCell;
globalThis.historyExportHeaders = historyExportHeaders;
globalThis.historyExportValues = historyExportValues;

const sample = {
    date: '2026-10-01',
    author: 'Ви',
    route: 'Київ → Львів',
    from: 'Київ',
    to: 'Львів',
    client: 'ТОВ "Ріг & Копито"',
    trailer: 'тент',
    km: 540,
    cars: 2,
    tons: 20.5,
    days: 2,
    rate: 1200,
    currency: 'UAH',
    revenue: 24000,
    profit: -1500.5,
    fact: null,
    perKm: -2.78,
    status: 'Чернетка'
};

test('history CSV uses UTF-8 BOM, semicolon and keeps cyrillic', () => {
    const csv = historyCsv([sample]);
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], historyExportHeaders().join(';'));
    assert.equal(lines[0].split(';').length, 18);
    assert.match(lines[1], /Київ → Львів/);
    assert.match(lines[1], /тент/);
    assert.match(lines[1], /Чернетка/);
    assert.equal(lines[1].includes(','), false);
});

test('history CSV quotes semicolons, quotes and newlines, and blocks formulas', () => {
    const csv = historyCsv([{
        date: '2026-10-02',
        author: 'a@b.c',
        route: '=HYPERLINK("http://evil")',
        from: 'A;B',
        to: 'B',
        client: 'рядок\nдва',
        trailer: 'зерновоз',
        km: null,
        cars: null,
        tons: null,
        days: null,
        rate: null,
        currency: 'EUR',
        revenue: null,
        profit: null,
        fact: 100,
        perKm: null,
        status: 'Виконано'
    }]);
    const line = csv.slice(1).split('\r\n')[1];
    assert.match(line, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
    assert.match(line, /"A;B"/);
    assert.match(line, /"рядок\nдва"/);
    assert.match(line, /;100;/);
    assert.equal(line.startsWith('2026-10-02;a@b.c;'), true);
    const cells = historyExportValues({
        date: '2026-10-01', author: 'Ви', route: 'Київ', from: '', to: '', client: '',
        trailer: '', km: 1, cars: 0, tons: null, days: null, rate: null, currency: 'UAH',
        revenue: null, profit: -1500.5, fact: null, perKm: null, status: 'Чернетка'
    }).map(historyCsvCell);
    assert.equal(cells[14], '-1500.5');
    assert.equal(cells[8], '0');
    assert.equal(cells[9], '');
});

test('history export filename keeps only real dates', () => {
    assert.equal(historyExportName('2026-10-01', '2026-10-13', 'csv'), 'TripControl_історія_2026-10-01_2026-10-13.csv');
    assert.equal(historyExportName('', '2026-10-13', 'xlsx'), 'TripControl_історія_початок_2026-10-13.xlsx');
    assert.equal(historyExportName('', '', 'csv'), 'TripControl_історія.csv');
    assert.equal(historyExportName('../etc', '2026-10-01', 'xlsx'), 'TripControl_історія_початок_2026-10-01.xlsx');
    assert.equal(historyExportName('2026-10-01', '2026-10-13', 'exe'), 'TripControl_історія_2026-10-01_2026-10-13.xlsx');
});

test('history export uses the filtered period, not the visible page, and adds no 1C keys', () => {
    const start = html.indexOf('async function exportHistory(');
    const end = html.indexOf('function historyActions(', start);
    const body = html.slice(start, end);
    assert.match(body, /historyExportRecords\(\)/);
    assert.match(html, /function historyExportRecords\(\) \{\s*return filteredHistory\(\)/);
    assert.equal(body.includes('HISTORY_PAGE_SIZE'), false);
    assert.match(html, /onclick="exportHistory\('csv'\)"/);
    assert.match(html, /onclick="exportHistory\('xlsx'\)"/);
    assert.match(html, /Експорт історії — після оплати/);
    assert.equal(/api[_-]?key|1[CС]|onec/i.test(body), false);
    assert.match(body, /loadExcelJS\(\)/);
    assert.equal(body.includes('innerHTML'), false);
    assert.match(historyExportHeaders().join(';'), /грн\/км маршруту/);
});

test('a route title fills empty origin and destination, and a filter miss is not an empty archive', () => {
    const historyPlacesFromName = extractFunction('historyPlacesFromName', ['name']);
    const historyEmptyMessage = extractFunction('historyEmptyMessage', ['savedCount', 'shownCount']);
    assert.deepEqual(historyPlacesFromName('Київ — Львів'), { from: 'Київ', to: 'Львів' });
    assert.deepEqual(historyPlacesFromName('Умань - Ізмаїл'), { from: 'Умань', to: 'Ізмаїл' });
    assert.deepEqual(historyPlacesFromName('Маршрут 1'), { from: '', to: '' });
    assert.equal(historyEmptyMessage(0, 0), 'Немає збережених розрахунків.');
    assert.equal(historyEmptyMessage(4, 0), 'Нічого не знайдено за фільтром.');
    assert.equal(historyEmptyMessage(4, 2), '');
    assert.match(html, /historyEmptyMessage\(savedCalculations\.length, rows\.length\)/);
    assert.match(html, /perKm: perKm === null \? null : Math\.round\(perKm\)/);
    assert.equal(html.includes('Math.round(perKm * 100)'), false);
    assert.equal(Math.round(-1500.4 / 540), -3);
});
