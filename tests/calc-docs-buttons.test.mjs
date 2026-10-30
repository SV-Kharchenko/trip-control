import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error('unclosed ' + name);
}

test('історія заявок: «Створити ТТН» і «Створити подорожній лист» лише для прийнятих заявок і лише власнику / логісту', async () => {
    const { default: vm } = await import('node:vm');
    const make = (role) => {
        const ctx = vm.createContext({ currentOrgRole: role, escHtml: (s) => String(s), historyFields: (row) => ({ status: row.status }) });
        vm.runInContext(fnSource('calcDocButtons'), ctx);
        return (row) => vm.runInContext('calcDocButtons(' + JSON.stringify(row) + ')', ctx);
    };
    const owner = make('owner');
    for (const status of ['draft', 'pending', 'rejected']) assert.equal(owner({ id: 'c1', status }), '', status + ': кнопок немає');
    for (const status of ['accepted', 'done']) {
        const out = owner({ id: 'c1', status });
        assert.match(out, /openCalcDoc\('ttn', 'c1'\)">Створити ТТН</);
        assert.match(out, /openCalcDoc\('trip_sheet', 'c1'\)">Створити подорожній лист</);
        assert.match(out, /openCalcDoc\('act', 'c1'\)">Створити акт</);
        assert.match(out, /openCalcDoc\('invoice', 'c1'\)">Створити рахунок</);
        assert.match(out, /showCalcDocs\('c1'\)/);
    }
    assert.notEqual(make('logist')({ id: 'c2', status: 'accepted' }), '');
    assert.equal(make('director')({ id: 'c2', status: 'accepted' }), '', 'директор лише читає');
});

test('кнопки ведуть у Контроль+ з id заявки; список документів заявки читає обидва списки за calculation_id; кнопки є і в режимі «лише перегляд»', () => {
    assert.match(fnSource('openCalcDoc'), /\['ttn', 'trip_sheet', 'act', 'invoice'\]\.indexOf\(kind\)/);
    assert.match(fnSource('openCalcDoc'), /#\/docs\/new\/' \+ target \+ '\/calc\/'/);
    const docs = fnSource('showCalcDocs');
    assert.match(docs, /kp_ttn_list/);
    assert.match(docs, /kp_trip_sheet_list/);
    assert.match(docs, /p_calculation: id/);
    assert.match(docs, /kp_calc_documents/, 'акти й рахунки заявки');
    const actions = fnSource('historyActions');
    assert.match(actions, /лише перегляд<\/span>' \+ calcDocButtons\(row\)/);
    assert.match(actions, /parts\.push\(calcDocButtons\(row\)\)/);
});
