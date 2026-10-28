import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start > 0, name);
    let depth = 0;
    for (let i = html.indexOf('{', start); i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}

test('п.2: перемикачі варіантів — «Варіант N · км · год хв», вибраний active, лінії без плашок', () => {
    const leg = (km, min) => ({ distance: { value: km * 1000 }, duration: { value: min * 60 } });
    const response = { routes: [{ summary: 'E40', legs: [leg(815, 582)] }, { summary: 'M06', legs: [leg(844, 600)] }] };
    const box = { innerHTML: '', classList: { on: false, add() { this.on = true; }, remove() { this.on = false; } } };
    const context = vm.createContext({ document: { getElementById: () => box }, escHtml: (x) => String(x) });
    vm.runInContext(['const ROUTE_ALT_MAX = 3;', fnSource('routeTotals'), fnSource('variantKmMinText'), fnSource('routeVariantText'), fnSource('routeVariantLabel'), fnSource('renderRouteAlternatives')].join('\n'), context);
    vm.runInContext('renderRouteAlternatives(' + JSON.stringify(response) + ', 1)', context);
    assert.equal(box.classList.on, true);
    assert.match(box.innerHTML, /Варіант 1 · 815 км · 9 год 42 хв<\/button>/);
    assert.match(box.innerHTML, /class="tc-map-alt active"[^>]*>Варіант 2 · 844 км · 10 год 0 хв/);
    assert.equal((box.innerHTML.match(/tc-map-alt active/g) || []).length, 1);
    assert.equal(html.includes('tcMapPillIcon'), false);
    assert.match(html, /\.tc-map-alt\.active \{ background: #0D2A29;/);
    assert.match(html, /\.tc-map-route-label:not\(\[hidden\]\)\) > \.tc-map-alts \{/);
});
