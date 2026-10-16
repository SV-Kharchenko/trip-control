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
            if (depth === 0) return new Function(...params, html.slice(open + 1, i));
        }
    }
    throw new Error('unclosed ' + name);
}

test('stage 4 keeps a dark result card, cascade and expense table on the existing totals', () => {
    assert.match(html, /#dispatcher-result:not\(\.is-empty\)/);
    assert.match(html, /background: #0D2A29/);
    assert.match(html, /#dispatcher-result:not\(\.is-empty\) \.tc-profit-hero,[\s\S]*background: transparent;/);
    assert.match(html, /grid-column: 1 \/ -1;\s*grid-row: 1;\s*align-self: start;\s*top: auto;/);
    assert.match(html, /#tc-cascade \.donut-legend-row \.nums \{[\s\S]*display: inline-flex;[\s\S]*gap: 8px;/);
    assert.match(html, /id="tc-cascade"/);
    assert.match(html, /Від доходу до прибутку/);
    assert.match(html, /id="tc-cost-table"/);
    assert.match(html, /Статті витрат/);
    assert.match(html, /<th>Стаття<\/th>/);
    assert.match(html, /<th>Сума<\/th>/);
    assert.match(html, /<th>На 1 т<\/th>/);
    assert.match(html, /<th>Частка<\/th>/);
    assert.match(html, /JetBrains Mono/);
    assert.match(html, /Заповніть маршрут і тариф/);
    assert.match(html, /#dispatcher-result\.is-empty #tc-result-empty \{ display: block; \}/);
    assert.match(html, /onclick="saveCalculation\(\)"/);
    assert.match(html, /onclick="window\.print\(\)"/);
    assert.match(html, /onclick="exportExcel\(\)"/);
    assert.match(html, /onclick="shareTelegram\(\)"/);
    assert.match(html, /class="btn full-only" type="button" onclick="shareTelegram\(\)"/);

    const paint = html.slice(html.indexOf('function paintProfitHero(result)'), html.indexOf('function syncStudioSums(result)'));
    assert.match(paint, /paintCascade\(null\)/);
    assert.match(paint, /paintCascade\(result\)/);
    assert.match(paint, /dock\.classList\.add\('is-empty'\)/);
    assert.match(paint, /dock\.classList\.remove\('is-empty'\)/);

    const rows = extractFunction('cascadeRows', ['result', 'opts']);
    const sample = rows({
        grossIncome: 184250,
        netIncome: 156612,
        marginalIncome: 62480,
        marginPerTon: 2499,
        ebitda: 41120,
        ebitdaPerTon: 1645,
        netProfit: 28940
    });
    assert.deepEqual(sample.map(function (row) { return row.key; }), [
        'Дохід',
        'Чистий дохід',
        '− Змінні витрати',
        'Маржинальний дохід',
        '− Накладні',
        'EBITDA',
        '− Амортизація, податки',
        'Чистий прибуток'
    ]);
    assert.equal(sample[0].amount, 184250);
    assert.equal(sample[1].amount, 156612);
    assert.equal(sample[3].amount, 62480);
    assert.equal(sample[5].amount, 41120);
    assert.equal(sample[7].amount, 28940);
    assert.equal(sample[2].amount, sample[1].amount - sample[3].amount);
    assert.equal(sample[4].amount, sample[3].amount - sample[5].amount);
    assert.equal(sample[6].amount, sample[5].amount - sample[7].amount);
    assert.equal(sample[7].tone, 'profit');
    assert.equal(rows({ grossIncome: 10, netIncome: 8, marginalIncome: 4, ebitda: 2, netProfit: -3 })[7].tone, 'loss');
    assert.deepEqual(rows(null), []);
});
