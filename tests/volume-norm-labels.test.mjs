// Підпис поля об'єму і довідка біля нормативної ваги в робочому калькуляторі (лише підписи, id і формули без змін).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = html.slice(html.indexOf('<div id="auth-screen">'));
const landing = html.slice(html.indexOf('<div id="landing-screen" hidden>'), html.indexOf('<div id="auth-screen">'));
const LABEL = "Об'єм (загальна вага) по заявці";

test("підпис #volume: «Об'єм (загальна вага) по заявці» у компактній розкладці й у вихідному HTML, «Вага вантажу» зникла", () => {
    assert.ok(html.includes(`opCell('tc-f-weight', "${LABEL}", [opRowOf('volume')])`));
    assert.ok(html.includes(`<label>${LABEL}:</label>
                    <input type="number" id="volume"`));
    assert.equal(html.includes('Вага вантажу'), false);
    assert.equal(html.includes("Загальний об'єм контракту:"), false);
    assert.match(html, /Відстань \| Об'єм \(загальна вага\) по заявці \| Тариф/);
    assert.match(html, /<input type="number" id="volume" tabindex="5" oninput="calculate\(\)">\s*<span class="unit">т<\/span>/);
    // Довгий підпис переноситься на другий рядок, а не обрізається «…».
    assert.match(html, /#tc-op \.tc-f-weight \.form-row > label[^{]*\{ white-space: normal !important; overflow: visible !important; text-overflow: clip !important; \}/);
});

test('лендинг (гостьовий калькулятор) не змінено', () => {
    assert.match(landing, /<label for="t-volume">Загальний об'єм контракту<\/label>/);
    assert.equal(landing.includes(LABEL), false);
});

test('довідка біля нормативної ваги: ⓘ + підказка з точним текстом; підпис не перейменовано', () => {
    assert.match(app, /<label>Нормативна вага на авто: <button type="button" class="tc-info" id="norm-weight-info-btn"[^>]*aria-expanded="false" aria-controls="norm-weight-info-tip" onclick="toggleNormWeightInfo\(event\)">ⓘ<\/button><\/label>/);
    assert.match(app, /<p id="norm-weight-info-tip" class="tc-tip" role="tooltip" hidden>Яка вага планується до перевезення одним авто<\/p>/);
    // Підказка позиціюється від рядка поля (position: relative), бо абсолютне .tc-tip раніше було зав'язане на .tc-vehicle-label.
    assert.match(app, /<div class="form-row tc-has-tip">\s*<label>Нормативна вага на авто:/);
    assert.match(html, /\.tc-has-tip \{ position: relative; \}/);
    assert.match(html, /<input type="number" id="norm-weight" tabindex="6" step="0.5" oninput="calculate\(\)">/);
    // Кнопка й підказка — всередині того самого рядка, що переїжджає в «Додаткові параметри».
    const row = app.slice(app.indexOf('<div class="form-row tc-has-tip">'), app.indexOf('id="cars-count"'));
    assert.ok(row.includes('norm-weight-info-btn') && row.includes('norm-weight-info-tip') && row.includes('id="norm-weight"'));
    assert.match(html, /opRowOf\('trailer-type'\), opRowOf\('norm-weight'\)/);
});

function fnSource(name) {
    const start = html.indexOf('function ' + name + '(');
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error(name);
}

test('toggleNormWeightInfo відкриває/закриває свою підказку, toggleVehicleInfo не зачеплено, клік поза закриває', () => {
    const els = {
        tip: { hidden: true }, btn: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, contains: () => false },
        vtip: { hidden: true }
    };
    const document = { getElementById: (id) => ({ 'norm-weight-info-tip': els.tip, 'norm-weight-info-btn': els.btn, 'vehicle-info-tip': els.vtip }[id] || null) };
    const toggle = new Function('document', fnSource('toggleNormWeightInfo') + '; return toggleNormWeightInfo;')(document);
    const ev = { prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
    toggle(ev);
    assert.equal(els.tip.hidden, false);
    assert.equal(els.btn.attrs['aria-expanded'], 'true');
    assert.equal(els.vtip.hidden, true, 'підказка «Авто з парку» не зачеплена');
    assert.ok(ev.prevented && ev.stopped, 'клік по кнопці в <label> не фокусує поле й не закриває підказку одразу');
    toggle(ev);
    assert.equal(els.tip.hidden, true);
    assert.equal(els.btn.attrs['aria-expanded'], 'false');
    assert.match(fnSource('toggleVehicleInfo'), /vehicle-info-tip[^]*vehicle-info-btn/);
    assert.match(html, /const normTip = document\.getElementById\('norm-weight-info-tip'\);[^]*?normTip\.hidden = true;/);
});
