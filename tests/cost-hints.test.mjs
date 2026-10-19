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
    assert.equal(H.intro, 'Усі суми в цьому блоці — річні, на весь парк. Паливо, ТО, шини, водія, дороги й податок з виручки сюди не вносьте — вони рахуються в окремих полях.');
    // Nothing about 300 days or how the sums are split — neither in the hints nor in the intro.
    for (const text of [H.intro, ...Object.values(H.fields)]) {
        assert.equal(/300|робоч|поділимо|ділимо|віднесемо|на дні рейсу/i.test(text), false, text);
    }
    // One object: the texts are nowhere else.
    for (const source of [html, landingJs]) {
        assert.equal(source.includes('Річна сума'), false);
        assert.equal(source.includes('вони рахуються в окремих полях'), false);
        assert.equal(source.includes('300 робочих днів'), false);
    }
    assert.equal((hintsJs.match(/var COST_HINTS = \{/g) || []).length, 1);
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
    // Delegated listeners work for buttons rendered later (cabinet, landing) and for taps on mobile;
    // Escape is caught in the capture phase, before the panel's own Escape.
    assert.match(hintsJs, /document\.addEventListener\('click', onClick\);/);
    assert.match(hintsJs, /document\.addEventListener\('keydown', onKeydown, true\);/);
});

// A tiny DOM: «?» buttons with their texts, a target elsewhere, document.activeElement.
function fakeDom() {
    const handlers = {};
    const elements = {};
    const doc = {
        activeElement: null,
        addEventListener: (type, fn, capture) => { handlers[type] = { fn, capture }; },
        getElementById: (id) => elements[id] || null,
        querySelectorAll: (sel) => {
            assert.equal(sel, '.tc-hint-btn[aria-expanded="true"]');
            return Object.values(elements).filter((el) => el.kind === 'button' && el.attrs['aria-expanded'] === 'true');
        }
    };
    const node = (kind, cls, extra) => {
        const el = { kind, cls, attrs: {}, hidden: false, ...extra };
        el.getAttribute = (k) => el.attrs[k];
        el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
        el.closest = (sel) => (sel === '.' + cls ? el : null);
        el.focus = () => { doc.activeElement = el; };
        return el;
    };
    const hint = (key) => {
        const text = node('text', 'tc-hint-text', { hidden: true });
        elements['h-' + key] = text;
        const button = node('button', 'tc-hint-btn');
        button.attrs = { 'aria-controls': 'h-' + key, 'aria-expanded': 'false' };
        elements['b-' + key] = button;
        return { button, text };
    };
    const sandbox = { window: {}, document: doc };
    vm.runInNewContext(hintsJs, sandbox);
    const event = (props) => {
        const e = { defaultPrevented: false, stopped: false, ...props };
        e.preventDefault = () => { e.defaultPrevented = true; };
        e.stopPropagation = () => { e.stopped = true; };
        return e;
    };
    return { handlers, hint, node, doc, event };
}

test('Esc closes the open hint, stops the event (the try panel stays open) and returns focus to its «?»', () => {
    const { handlers, hint, doc, event } = fakeDom();
    assert.equal(handlers.keydown.capture, true);
    const admin = hint('admin');
    const fin = hint('fin');
    handlers.click.fn(event({ target: admin.button }));
    assert.equal(admin.text.hidden, false);
    assert.equal(admin.button.attrs['aria-expanded'], 'true');
    doc.activeElement = null;
    const esc = event({ key: 'Escape' });
    handlers.keydown.fn(esc);
    assert.equal(admin.text.hidden, true);
    assert.equal(admin.button.attrs['aria-expanded'], 'false');
    assert.equal(esc.defaultPrevented, true);
    assert.equal(esc.stopped, true, 'the panel\'s Escape does not run');
    assert.equal(doc.activeElement, admin.button);
    // Nothing open → Escape passes through untouched (the panel closes as before).
    const pass = event({ key: 'Escape' });
    handlers.keydown.fn(pass);
    assert.equal(pass.defaultPrevented, false);
    assert.equal(pass.stopped, false);
    // Other keys are ignored.
    handlers.click.fn(event({ target: fin.button }));
    const other = event({ key: 'Enter' });
    handlers.keydown.fn(other);
    assert.equal(fin.text.hidden, false);
    assert.equal(other.stopped, false);
});

test('a click outside «?» and outside the hint text closes all hints; clicks on them do not', () => {
    const { handlers, hint, node, event } = fakeDom();
    const admin = hint('admin');
    const repair = hint('repair');
    handlers.click.fn(event({ target: admin.button }));
    handlers.click.fn(event({ target: repair.button }));
    assert.equal(admin.text.hidden, false, 'opening one does not close another');
    assert.equal(repair.text.hidden, false);
    handlers.click.fn(event({ target: admin.text }));
    assert.equal(admin.text.hidden, false, 'click inside the text keeps it open');
    const outside = node('other', 'lp-form-row');
    handlers.click.fn(event({ target: outside }));
    assert.equal(admin.text.hidden, true);
    assert.equal(repair.text.hidden, true);
    assert.equal(admin.button.attrs['aria-expanded'], 'false');
    assert.equal(repair.button.attrs['aria-expanded'], 'false');
    // The same «?» toggles its own hint.
    handlers.click.fn(event({ target: admin.button }));
    handlers.click.fn(event({ target: admin.button }));
    assert.equal(admin.text.hidden, true);
});

test('styles in assets/cost-hints.css (cabinet does not depend on landing.css); cache versions bumped', () => {
    const css = read('assets/cost-hints.css');
    assert.match(css, /\.tc-hint-btn \{[^}]*width: 22px; height: 22px;/);
    assert.match(css, /\.tc-hint-btn::before \{ content: ''; position: absolute; inset: -11px; \}/);
    assert.match(css, /\.tc-hint-text\[hidden\] \{ display: none; \}/);
    // body.layout-studio button { min-width: 40px } on phones must not stretch «?».
    assert.match(css, /#landing-screen \.tc-hint-btn \{ width: 22px; height: 22px; min-height: 0; min-width: 22px; \}/);
    assert.match(css, /#cabinet-screen \.tc-hint-btn \{ width: 22px; height: 22px; min-height: 0; min-width: 22px; \}/);
    assert.equal(read('assets/landing.css').includes('.tc-hint-'), false);
    for (const asset of ['landing.css', 'cost-hints.css']) {
        assert.match(html, new RegExp('<link rel="stylesheet" href="/assets/' + asset.replace('.', '\\.') + '\\?v=2026-10-20">'), asset);
    }
    for (const asset of ['cost-hints.js', 'landing.js']) {
        assert.match(html, new RegExp('<script src="/assets/' + asset.replace('.', '\\.') + '\\?v=2026-10-20" defer></script>'), asset);
    }
    // Step 5 note on «ви».
    assert.match(html, /\(вкладки Парк, Пальне, Водій, ТО\): вводите один раз, і вони підставляються в кожен розрахунок/);
    assert.equal(html.includes('ТО): вводиш один раз'), false);
});
