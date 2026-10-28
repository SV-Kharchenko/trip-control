import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const decl = (body, prop) => { const m = body.match(new RegExp('(?:^|;|\\s)' + prop + ':\\s*([^;]+)')); return m ? m[1].trim() : null; };

// Кнопки кабінету: за розміром тексту. Повна ширина — лише через явний .btn-block; рядок-заголовок акордеону Автопарку — не кнопка дії.
const ROW_HEADERS = /\.tc-fleet-toggle/;

test('the base .btn is content-sized (no flex:1, no min-width:150px, no display:block); full width only with .btn-block', () => {
    const base = rules.find((r) => r.selector === '.btn');
    assert.ok(base, '.btn rule');
    assert.equal(decl(base.body, 'flex'), '0 0 auto');
    assert.equal(decl(base.body, 'width'), 'auto');
    assert.equal(decl(base.body, 'min-width'), '0');
    assert.equal(decl(base.body, 'display'), 'inline-flex');
    const block = rules.find((r) => r.selector === '.btn-block');
    assert.ok(block && decl(block.body, 'width') === '100%', '.btn-block is the explicit full-width class');
    // Панель дій калькулятора розтягує свої кнопки сама, а не через базовий клас.
    const bar = rules.find((r) => r.selector === '.actions-bar .btn');
    assert.ok(bar && decl(bar.body, 'flex') === '1');
});

test('no cabinet rule stretches a button: no width:100%, flex:1 or display:block on buttons / .btn', () => {
    const offenders = [];
    for (const { selector, body } of rules) {
        const parts = selector.split(',').map((p) => p.trim()).filter((p) => p.includes('#cabinet-screen'));
        for (const part of parts) {
            if (!/(^|[\s>])(button|a\.btn)\b|\.btn\b|\.cab-save|\.cab-cancel/.test(part) || /\.btn-block/.test(part) || ROW_HEADERS.test(part)) continue;
            if (/\b(input|select|textarea)\b/.test(part.split(/[\s>]+/).pop())) continue;
            const width = decl(body, 'width');
            const flex = decl(body, 'flex');
            const display = decl(body, 'display');
            if (width === '100%' || (flex && /^1(\s|$)/.test(flex)) || display === 'block') offenders.push(part + ' { ' + body.trim().slice(0, 80) + ' }');
        }
    }
    assert.deepEqual(offenders, []);
});

test('every .btn in the cabinet is forced to content width and the cabinet markup has no inline full-width buttons', () => {
    assert.ok(rules.some((r) => r.selector === '#cabinet-screen .btn:not(.btn-block)' && decl(r.body, 'width') === 'auto' && decl(r.body, 'flex') === 'none'));
    const start = html.indexOf('<div id="cabinet-screen">');
    const markup = html.slice(start, html.indexOf('<footer class="tc-legal-footer">', start));
    const built = html.slice(html.indexOf('function buildCabinet('), html.indexOf('const FLEET_DOCS = ['));
    for (const chunk of [markup, built]) {
        const buttons = [...chunk.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
        assert.ok(buttons.length >= 3);
        for (const tag of buttons) assert.equal(/width:\s*100%|btn-block/.test(tag), false, tag);
    }
});

test('"Позначити все прочитаним": content width, pushed to the right above the list', () => {
    assert.ok(rules.some((r) => r.selector === '#cabinet-screen #cab-notes-all' && decl(r.body, 'margin-left') === 'auto'));
    assert.match(html, /<div class="cab-card-head"><h3>Сповіщення<\/h3><button type="button" class="btn" id="cab-notes-all"/);
    const head = rules.find((r) => r.selector === '#cabinet-screen .cab-card-head');
    assert.equal(decl(head.body, 'display'), 'flex');
    assert.equal(decl(head.body, 'justify-content'), 'space-between');
});
