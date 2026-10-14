import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceBetween(source, startMark, endMark) {
    const start = source.indexOf(startMark);
    const end = source.indexOf(endMark, start + startMark.length);
    assert.ok(start !== -1 && end !== -1, startMark + ' … ' + endMark);
    return source.slice(start, end);
}

test('the calculator form is a 4-step stepper without a show-all mode', () => {
    const arrange = sliceBetween(html, 'function arrangeDispatcherForm()', 'const RECENT_ROUTES_KEY');
    assert.match(arrange, /stepper\.id = 'tc-stepper'/);
    assert.match(arrange, /id="tc-step-panel-1"/);
    assert.match(arrange, /id="tc-step-panel-2"/);
    assert.match(arrange, /id="tc-step-panel-3"/);
    assert.match(arrange, /id="tc-step-panel-4"/);
    assert.match(arrange, /Маршрут/);
    assert.match(arrange, /Вантаж і тариф/);
    assert.match(arrange, /Пальне/);
    assert.match(arrange, /Додатково/);
    assert.match(arrange, /Крок 1 з 4/);
    assert.match(arrange, />Назад</);
    assert.match(arrange, />Далі</);
    assert.match(arrange, /take\(1, document\.querySelector\('\.poi-box'\)\)/);
    assert.match(arrange, /take\(2, document\.getElementById\('vehicle-norm-row'\)\)/);
    assert.match(arrange, /take\(3, document\.querySelector\('\.tc-lower'\)\)/);
    assert.match(arrange, /work\.insertBefore\(banner, card\)/);
    assert.match(arrange, /addEventListener\('click', function \(\) \{ showCalcStep\(calcStep - 1\); \}\)/);
    assert.match(arrange, /addEventListener\('click', function \(\) \{ showCalcStep\(calcStep \+ 1\); \}\)/);
    assert.equal(arrange.includes('всі кроки'), false);
    assert.equal(arrange.includes('show-all'), false);
    assert.equal(arrange.includes('fuel-load'), false);
    assert.equal(arrange.includes('total-fleet'), false);
    assert.equal(arrange.includes('.disabled'), false);

    const stepFn = sliceBetween(html, 'function showCalcStep(n, focusTab)', 'function stepFieldText(id)');
    assert.match(stepFn, /panel\.hidden = !on/);
    assert.match(stepFn, /back\.hidden = calcStep === 1/);
    assert.match(stepFn, /fwd\.hidden = calcStep === 4/);
    assert.match(stepFn, /'Крок ' \+ calcStep \+ ' з 4'/);
    assert.equal(stepFn.includes('disabled'), false);

    const invalid = sliceBetween(html, 'function markInvalidFields(missing)', 'function showToast(');
    assert.match(invalid, /input\.closest\('\.tc-step-panel'\)/);
    assert.match(invalid, /if \(step\) showCalcStep\(step\)/);
    assert.match(invalid, /details\.tc-more/);

    const mount = sliceBetween(html, 'function mountStudioDom()', 'function formatMoney(');
    assert.match(mount, /nodes\.lower\.closest\('#tc-stepper'\)/);
    assert.match(mount, /nodes\.poi\.closest\('#tc-stepper'\)/);

    assert.match(html, /\.tc-step-panel\[hidden\] \{ display: none !important; \}/);
    assert.match(html, /body\.layout-studio details\.tc-more summary \{ min-height: 44px;/);
    assert.match(html, /id="main-sync-fields"/);
    assert.match(html, /id="fuel-load"/);
    assert.match(html, /id="dist"/);
    assert.match(html, /id="volume"/);
    assert.match(html, /id="fuel-price"/);
    assert.match(html, /id="season-type"/);
    assert.match(html, /id="adblue-enable"/);
    assert.match(html, /Весь автопарк/);
    assert.match(html, /Вибір авто/);
    assert.match(html, /\+ Проміжна зупинка/);
    assert.match(html, /dismissHint\('onboard-banner'\)/);
});
