import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const hintsJs = read('assets/cost-hints.js');
const landingJs = read('assets/landing.js');

const sandbox = { window: {} };
vm.runInNewContext(hintsJs, sandbox);
const H = sandbox.window.TcCostHints;
const plain = (value) => JSON.parse(JSON.stringify(value));

const OVERHEADS = {
    'overhead-amort': 'amort',
    'overhead-admin': 'admin',
    'overhead-other-op': 'otherOperating',
    'overhead-other': 'otherExpenses',
    'overhead-repair': 'repair',
    'overhead-fin': 'fin'
};

test('each of the 6 annual overhead fields has a hint with «Річна»; texts live in one object', () => {
    assert.deepEqual(plain(H.ids), OVERHEADS);
    assert.deepEqual(Object.keys(H.fields).sort(), Object.values(OVERHEADS).sort());
    for (const key of Object.values(OVERHEADS)) {
        assert.match(H.fields[key], /^Річна сума: /, key);
    }
    assert.match(H.fields.fin, /Тіло кредиту не вносьте$/);
    assert.match(H.fields.otherExpenses, /Податок з виручки рейсу сюди не вносьте$/);
    assert.equal(H.intro, 'Усі суми в цьому блоці — річні, на весь парк. Ми поділимо їх на кількість авто й 300 робочих днів і віднесемо на дні рейсу. Паливо, ТО, шини, водія, дороги й податок з виручки сюди не вносьте — їх уже пораховано');
    // One object: the texts are nowhere else.
    for (const source of [html, landingJs]) {
        assert.equal(source.includes('Річна сума'), false);
        assert.equal(source.includes('300 робочих днів'), false);
    }
    assert.equal((hintsJs.match(/var COST_HINTS = \{/g) || []).length, 1);
    // The intro matches the formula: per vehicle and 300 work days, then times the trip days.
    const calc = read('api/calculate.js');
    assert.match(calc, /const workDaysYear = 300;/);
    assert.match(calc, /const dailyAdmin = adminYear \/ \(totalFleet \* workDaysYear\);/);
});

test('cabinet «Витратна частина»: «?» next to each overhead label, text under the field, intro above the block', () => {
    const cab = html.slice(html.indexOf('const CAB_SECTIONS = ['), html.indexOf("{ title: 'Пальне та AdBlue'"));
    const keys = [...cab.matchAll(/\{ key: '(\w+)', id: '(overhead-[\w-]+)'/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(Object.fromEntries(keys), OVERHEADS, 'cabinet keys = hint keys');
    assert.match(html, /<script src="\/assets\/cost-hints\.js\?v=[\d-]+" defer><\/script>\n\s+<script src="\/assets\/landing\.js/);
    const fieldHtml = html.slice(html.indexOf('function fieldHtml(f) {'), html.indexOf('function profileFieldHtml(f) {'));
    assert.match(fieldHtml, /if \(hints && hints\.fields\[f\.key\]\) \{/);
    assert.match(fieldHtml, /hints\.button\(f\.key, 'cab-hint-', f\.label\)/);
    assert.match(fieldHtml, /hints\.text\(f\.key, 'cab-hint-'\)/);
    assert.match(html, /\{ n: '1', title: 'Витрати автопарку', note: window\.TcCostHints \? window\.TcCostHints\.intro :/);
    assert.match(html, /#cabinet-screen \.tc-hint-head > label \{/);
});

test('landing panel step 5: the same hints for every overhead field there', () => {
    const panel = html.slice(html.indexOf('id="t-panel-5"'), html.indexOf('</form>', html.indexOf('id="t-panel-5"')));
    for (const id of Object.keys(OVERHEADS)) assert.match(panel, new RegExp('id="t-' + id + '" name="' + id + '"'), id);
    assert.match(landingJs, /Object\.keys\(hints\.ids\)\.forEach\(function \(id\) \{/);
    assert.match(landingJs, /hints\.button\(key, 'lp-hint-', label\.textContent\)/);
    assert.match(landingJs, /row\.insertAdjacentHTML\('afterend', hints\.text\(key, 'lp-hint-'\)\);/);
    assert.match(landingJs, /\$\('lp-cost-intro'\)\.textContent = hints\.intro;/);
});

test('hint markup and toggle: button with aria, text hidden until click / tap', () => {
    const button = H.button('admin', 'cab-hint-', 'Адміністративні витрати (річні)');
    assert.equal(button, '<button type="button" class="tc-hint-btn" aria-expanded="false" aria-controls="cab-hint-admin" aria-label="Підказка: Адміністративні витрати (річні)">?</button>');
    const text = H.text('admin', 'cab-hint-');
    assert.match(text, /^<p class="tc-hint-text" id="cab-hint-admin" hidden>Річна сума: бухгалтер/);
    assert.equal(/<[a-z]/i.test(H.text('fin', 'x-').replace(/^<p[^>]*>|<\/p>$/g, '')), false, 'text is escaped');
    const panel = { hidden: true };
    const attrs = { 'aria-controls': 'cab-hint-admin', 'aria-expanded': 'false' };
    const fakeButton = { getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } };
    const toggleSandbox = { window: {}, document: { addEventListener() {}, getElementById: (id) => (id === 'cab-hint-admin' ? panel : null) } };
    vm.runInNewContext(hintsJs, toggleSandbox);
    toggleSandbox.window.TcCostHints.toggle(fakeButton);
    assert.equal(panel.hidden, false);
    assert.equal(attrs['aria-expanded'], 'true');
    toggleSandbox.window.TcCostHints.toggle(fakeButton);
    assert.equal(panel.hidden, true);
    // A delegated click works for buttons rendered later (cabinet, landing) and for taps on mobile.
    assert.match(hintsJs, /document\.addEventListener\('click', function \(e\) \{\n\s+var button = e\.target && e\.target\.closest \? e\.target\.closest\('\.tc-hint-btn'\) : null;/);
    const css = read('assets/landing.css');
    assert.match(css, /\.tc-hint-btn::before \{ content: ''; position: absolute; inset: -11px; \}/);
    assert.match(css, /\.tc-hint-text\[hidden\] \{ display: none; \}/);
});
