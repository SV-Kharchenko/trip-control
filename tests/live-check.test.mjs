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

test('360px studio layout stacks columns for the light and dark themes only', () => {
    const block = sliceBetween(html, '/* live-check-360:', '/* /live-check-360 */');
    assert.match(block, /@media \(max-width: 360px\)/);
    assert.match(block, /body\.layout-studio #studio-columns \{/);
    assert.match(block, /grid-template-columns: minmax\(0, 1fr\) !important/);
    assert.match(block, /body\.layout-studio \.tc-profit-value \{[\s\S]*font-size: 20px/);
    assert.equal(/ocean|paper|control|tc-actions/i.test(block), false);
});

test('invalid input cancels an in-flight calculation and clears the visible result', () => {
    const calc = sliceBetween(html, 'async function calculate()', 'function clearCalcVisuals()');
    const missing = sliceBetween(calc, 'if (missing.length)', 'markInvalidFields([]);');
    assert.match(missing, /invalidateCalcResult\(\)/);
    const missingReturn = missing.lastIndexOf('return;');
    const invalidateAt = missing.indexOf('invalidateCalcResult()');
    assert.ok(invalidateAt !== -1 && invalidateAt < missingReturn);

    const requestLine = calc.indexOf('const myRequestId = ++calcRequestId');
    assert.ok(requestLine > missing.indexOf('invalidateCalcResult()'));

    assert.match(calc, /if \(myRequestId !== calcRequestId\) return;/);
    const rejected = sliceBetween(calc, "errInfo.code === 'MISSING_FIELDS'", 'throw new Error');
    assert.match(rejected, /clearCalcVisuals\(\)/);
    assert.match(calc, /if \(myRequestId === calcRequestId\) clearCalcVisuals\(\)/);

    const clear = sliceBetween(html, 'function clearCalcVisuals()', 'function invalidateCalcResult()');
    assert.match(clear, /paintProfitHero\(null\)/);
    assert.match(clear, /cost-breakdown/);
    assert.match(clear, /fuel-summary-box/);
    assert.match(clear, /renderChart\(0, 0, 0, 0, 0, 0\)/);
    assert.match(clear, /lastCalcData = \{\}/);
    assert.match(clear, /lastExport = null/);
    assert.match(html, /function invalidateCalcResult\(\) \{\s*calcRequestId\+\+;\s*clearCalcVisuals\(\);/);
});

test('slow route keeps an alternatives timeout and ignores a stale attempt', () => {
    const route = sliceBetween(html, 'function calculateGoogleRoute()', 'function routeTotals(');
    assert.match(route, /provideRouteAlternatives = true/);
    assert.match(route, /const timeoutMs = usedAlts \? 18000 : \(canTryAlts \? 12000 : 20000\)/);
    assert.match(route, /const routeGen = \+\+routeRequestGen/);
    assert.match(route, /routeGen !== routeRequestGen/);
    assert.match(route, /failFinal\('❌ Google Maps не відповів \(Directions\)/);
    const failedApply = sliceBetween(route, "} catch (err) {", 'return;');
    assert.match(failedApply, /setRouteBusy\(false\)/);
    assert.match(html, /let routeRequestGen = 0;/);
    assert.match(html, /let routeAttemptTimer = null;/);
});
