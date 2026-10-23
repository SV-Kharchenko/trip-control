import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const OLD_LABEL = 'Фактичний простій';
const NEW_LABEL = 'Можливий простій понад норму';

// Усе, що бачить користувач сайту й Контроль+ (він копіює index.html, assets/ і legal/ сайту).
const uiFiles = ['index.html', '404.html', 'offline.html']
    .concat(readdirSync(new URL('../assets/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => 'assets/' + f))
    .concat(readdirSync(new URL('../legal/', import.meta.url)).filter((f) => f.endsWith('.html')).map((f) => 'legal/' + f))
    .concat(readdirSync(new URL('../apps/kontrol-plus/src/views/', import.meta.url)).map((f) => 'apps/kontrol-plus/src/views/' + f))
    .concat(['apps/kontrol-plus/src/bridge.js', 'apps/kontrol-plus/src/ui.js']);

test('the old idle label is gone from every UI file', () => {
    for (const file of uiFiles) {
        const text = read(file);
        assert.equal(text.includes(OLD_LABEL), false, file);
        assert.equal(/простій \(понад норму\)/i.test(text), false, file);
    }
});

test('the planned idle field is «Можливий простій понад норму»; ids, keys and math unchanged', () => {
    assert.match(html, /<label>Можливий простій понад норму:<\/label>\s*<input type="number" id="idle-days" value="0" step="0\.5" oninput="calculate\(\)">/);
    assert.match(html, /<label for="t-idle-days">Можливий простій понад норму<\/label>/);
    assert.equal(html.split(NEW_LABEL).length - 1, 2, 'calculator step 4 and the landing try-form');
    assert.match(html, /idleDays: document\.getElementById\('idle-days'\)\.value,/);
    assert.match(html, /idleRate: document\.getElementById\('idle-rate'\)\.value,/);
    assert.match(html, /\['idleDays', 'idle-days'\], \['idleRate', 'idle-rate'\]/);
    assert.match(read('api/calculate.js'), /const idleDays = parseFloat\(body\.idleDays\) \|\| 0;/);
});

test('step summary, overview and landing use the planned wording', () => {
    assert.match(html, /parts\.push\(idle \? \('можливий простій ' \+ idle \+ ' діб'\) : 'без простою'\);/);
    assert.match(html, /<h3>Можливий простій<\/h3>/);
    assert.match(html, /Рейсів із закладеним простоєм немає\./);
    assert.equal(html.includes('фактичний дохід і витрати поруч із планом'), false);
});

test('«фактичний» is used only inside the «Факт» editor', () => {
    const editor = html.slice(html.indexOf('<div id="fact-editor" hidden>'), html.indexOf('<div class="comparison-table">', html.indexOf('<div id="fact-editor" hidden>')));
    const scriptEditor = html.slice(html.indexOf('    // Редактор «Факт» (v2)'), html.indexOf('    async function saveFactAlertPct() {'));
    const rest = html.replace(editor, '').replace(scriptEditor, '');
    assert.ok(editor.includes('Фактичний час на ходку'));
    assert.equal(/[Фф]актичн/.test(rest), false);
});
