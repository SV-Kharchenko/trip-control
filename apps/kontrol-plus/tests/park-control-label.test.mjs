// Кнопка й тексти, що ведуть в AGRO (SSO), називаються «Park-Control»; «АГРО» / «AGRO» як назви продукту у видимих текстах Контроль+ немає.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGRO_STUB_BUTTON, AGRO_STUB_OFF, AGRO_STUB_TEXT } from '../src/views/agro-stub.js';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

test('кнопка в шапці й у шторці: текст «Park-Control», title і aria-label «Відкрити Park-Control»', () => {
    const shell = read('src/shell.js');
    assert.match(shell, /title: 'Відкрити Park-Control', 'aria-label': 'Відкрити Park-Control', onclick: openAgro \}, 'Park-Control'\)/);
    assert.equal((shell.match(/Не вдалося відкрити Park-Control\./g) || []).length, 2);
});

test('заглушка й кабінет «Платформа»: усі тексти з «Park-Control»', () => {
    for (const s of [AGRO_STUB_TEXT, AGRO_STUB_BUTTON, AGRO_STUB_OFF]) assert.match(s, /Park-Control/);
});

test('у рядкових літералах src/ немає «АГРО» / «AGRO» (крім кодів AGRO_*, ключів agro.*, URL і доменів)', () => {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(new URL(d, root), { withFileTypes: true })) { const p = d + '/' + e.name; if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
    walk('src');
    const bad = [];
    for (const f of files) {
        read(f).split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            for (const m of line.matchAll(/(['"`])((?:\.|(?!\1).)*)\1/g)) {
                const s = m[2].replace(/AGRO_[A-Z_]+|AGROCONTROL\w*|[Aa]gro[._\-/]\S*|https?:\/\/\S+/g, '');
                if (/АГРО|AGRO/.test(s)) bad.push(f + ':' + (i + 1) + ': ' + m[2].slice(0, 80));
            }
        });
    }
    assert.deepEqual(bad, []);
});

test('на телефоні кнопка в шторці за розміром вмісту, не на всю ширину; у шапці її немає', () => {
    const phone = read('src/kp-shell.css');
    const rule = phone.match(/\.kp-shell-agro\.kp-shell-agro-m \{ display: inline-flex;[^}]*\}/)[0];
    assert.match(rule, /display: inline-flex[^}]*width: auto/);
    assert.equal(/[^-]width: (100%|calc)/.test(rule), false);
    assert.match(phone, /body\.kp-shell-on \.kp-shell-agro \{ display: none; \}/);
});
