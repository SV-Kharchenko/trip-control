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
    assert.match(arrange, /← Назад/);
    assert.match(arrange, /Далі →/);
    assert.match(arrange, /strip\.id = 'tc-step-strip'/);
    assert.match(arrange, /id="tc-recent-toggle"/);
    assert.match(arrange, /aria-expanded="false"/);
    assert.match(arrange, /aria-controls="tc-recent-panel"/);
    assert.equal(arrange.includes("rowOf('client-name')"), false);
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

    const invalid = sliceBetween(html, 'function markInvalidFields(missing)', 'function revealInvalidStep()');
    assert.match(invalid, /input\.closest\('\.tc-step-panel'\)/);
    assert.match(invalid, /classList\.add\('is-invalid'\)/);
    assert.match(invalid, /setAttribute\('aria-invalid', 'true'\)/);
    assert.match(invalid, /details\.tc-more/);
    assert.equal(invalid.includes('showCalcStep'), false);

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

test('calculate() does not change calcStep', () => {
    const calc = sliceBetween(html, 'async function calculate()', 'function clearCalcVisuals()');
    assert.equal(calc.includes('showCalcStep'), false);
    assert.equal(calc.includes('calcStep'), false);
    const reveal = sliceBetween(html, 'function revealInvalidStep()', 'function missingHintHtml(');
    assert.match(reveal, /showCalcStep\(step\)/);
    const demo = sliceBetween(html, 'async function runDemoCalc()', 'const AUTH_RATE');
    assert.match(demo, /revealInvalidStep\(\)/);
    const hint = sliceBetween(html, 'function missingHintHtml(missing)', 'function showToast(');
    assert.match(hint, /onclick="showCalcStep\(' \+ n \+ '\)"/);
});

test('one recent-routes disclosure, hidden client field, compact empty result', () => {
    assert.match(html, /tc_recent_open/);
    assert.match(html, /Останні маршрути ▾/);
    assert.match(html, /Заповніть маршрут і тариф/);
    assert.match(html, /color: var\(--warning-text\)/);
    assert.match(html, /id="client-name"/);
    assert.match(html, /tc-keep-hidden/);
    assert.match(html, /#dispatcher-result\.is-empty #tc-result-empty \{ display: block; \}/);
    assert.match(html, /@media \(max-width: 720px\)/);
    const recent = sliceBetween(html, 'function renderRecentRoutes()', 'function rememberRecentRoute()');
    const saved = sliceBetween(html, 'function renderSavedRecent()', 'function renderTemplateList()');
    assert.equal(recent.includes('Останні маршрути'), false);
    assert.equal(saved.includes('Останні маршрути'), false);
    assert.equal((html.match(/id="tc-recent-toggle"/g) || []).length, 1);
    const save = sliceBetween(html, 'async function saveCalculation()', 'async function removeSaved(');
    assert.match(save, /if \(keptClient\) inputs\.clientName = keptClient/);
    assert.match(save, /else if \(!inputs\.clientName\) delete inputs\.clientName/);
    const payload = sliceBetween(html, 'function readTripPayload()', 'function renderVehicleBreakdown(');
    assert.match(payload, /clientName: clientNameValue\(\)/);
    const mount = sliceBetween(html, 'function mountStudioDom()', 'function formatMoney(');
    assert.match(mount, /getElementById\('tc-step-strip'\)/);
    const demoFill = sliceBetween(html, 'function fillDemoTrip()', 'const CALC_STEP_TITLES');
    assert.match(demoFill, /getElementById\('client-name'\)/);
    assert.match(demoFill, /client\.value = ''/);
});

function grab(name) {
    const match = html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n    \\}'));
    assert.ok(match, name + ' is missing from index.html');
    const args = match[0].slice(match[0].indexOf('(') + 1, match[0].indexOf(')'));
    return new Function(...args.split(',').map((part) => part.trim()).filter(Boolean), match[1]);
}

test('recent route chips keep one chip per from-to pair', () => {
    const recentPlaceKey = grab('recentPlaceKey');
    globalThis.recentPlaceKey = recentPlaceKey;
    const mergeRecentChips = grab('mergeRecentChips');
    const saved = [
        { from: 'Київ', to: 'Львів', at: '2026-10-02T08:00:00.000Z', id: 'saved-kyiv' },
        { from: 'київ', to: ' львів ', at: '2026-09-01T08:00:00.000Z', id: 'saved-old' },
        { from: 'Одеса', to: 'Київ', at: '2026-08-01T08:00:00.000Z', id: 'odesa' },
        { from: 'Дніпро', to: 'Харків', at: '2026-10-09T08:00:00.000Z', id: 'dnipro' }
    ];
    const local = [
        { from: 'Київ', to: 'Львів', at: '2026-10-10T08:00:00.000Z', index: 0 },
        { from: '  КИЇВ ', to: 'ЛЬВІВ', at: '2026-07-01T08:00:00.000Z', index: 1 },
        { from: 'Львів', to: 'Одеса', at: '2026-10-12T08:00:00.000Z', index: 2 },
        { from: 'дніпро', to: 'харків', at: '2026-06-01T08:00:00.000Z', index: 4 }
    ];
    const chips = mergeRecentChips(saved, local, 8);
    const keys = chips.map((chip) => recentPlaceKey(chip.from, chip.to));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys.filter((key) => key === 'київ→львів').length, 1);
    assert.deepEqual(keys, ['львів→одеса', 'київ→львів', 'дніпро→харків', 'одеса→київ']);
    assert.equal(chips[0].kind, 'local');
    assert.equal(chips[0].index, 2);
    assert.equal(chips[1].kind, 'local');
    assert.equal(chips[1].index, 0);
    assert.equal(chips[1].from, 'Київ');
    assert.equal(chips[2].kind, 'saved');
    assert.equal(chips[2].id, 'dnipro');
    assert.equal(chips[3].id, 'odesa');
    assert.equal(mergeRecentChips([{ from: '  ', to: 'Львів', id: 'blank' }], [], 8).length, 0);
    const many = [];
    for (let i = 0; i < 10; i++) {
        many.push({ from: 'Місто ' + i, to: 'Склад', at: '2026-01-' + String(i + 1).padStart(2, '0') + 'T00:00:00.000Z', id: 's' + i });
    }
    const capped = mergeRecentChips(many, [], 8);
    assert.equal(capped.length, 8);
    assert.equal(capped[0].id, 's9');
    assert.equal(mergeRecentChips(many, []).length, 8);
    const paint = sliceBetween(html, 'function renderMergedRecent()', 'function renderRecentRoutes()');
    assert.match(paint, /getElementById\('saved-recent'\)/);
    assert.match(paint, /getElementById\('recent-routes'\)/);
    assert.match(paint, /openSaved\(\\'' \+ escHtml\(chip\.id\)/);
    assert.match(paint, /applyRecentRoute\(' \+ chip\.index \+ '\)/);
    assert.equal((paint.match(/box\.innerHTML = chips/g) || []).length, 1);
});
