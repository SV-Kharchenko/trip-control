// Стилі розділів Контроль+ у слотах «Особистого кабінету» (Реквізити, Статистика). Усі правила crm.css прив'язані до #kp-crm,
// а слоти лежать в #cabinet-screen поза ним, тож з crm.css генерується копія з тим самим набором правил для `#cabinet-screen .cab-slot`.
// Правила про лівий бік меню, шапку й сторінку сайту (#main-app, #kp-side, #kp-toast, kp-nav, data-kp-view) не копіюються.
//   node scripts/gen-slot-css.mjs          — переписати src/cabinet-slot.css
//   tests/cabinet-slots.test.mjs           — падає, якщо файл застарів
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SLOT = '#cabinet-screen .cab-slot';
const SKIP = /#main-app|#kp-side|#kp-toast|\.kp-side|kp-nav|data-kp-view|:not\(#kp-crm\)|#sticky-top|#studio-|#tc-/;

function splitTop(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                out.push(text.slice(start, i + 1).trim());
                start = i + 1;
            }
        }
    }
    return out.filter(Boolean);
}

function convertSelectors(list) {
    const kept = list.split(',').map((s) => s.trim()).filter((s) => s.includes('#kp-crm') && !SKIP.test(s));
    return kept.map((s) => s.replace(/#kp-crm/g, SLOT));
}

function convertRule(rule) {
    const open = rule.indexOf('{');
    const head = rule.slice(0, open).trim();
    const body = rule.slice(open + 1, rule.lastIndexOf('}'));
    if (head.startsWith('@keyframes') || head.startsWith('@font-face')) return null;
    if (head.startsWith('@media') || head.startsWith('@supports')) {
        const inner = splitTop(body).map(convertRule).filter(Boolean);
        return inner.length ? head + ' {\n' + inner.map((r) => '  ' + r.replace(/\n/g, '\n  ')).join('\n') + '\n}' : null;
    }
    const selectors = convertSelectors(head);
    // `#kp-crm { display: none }` ховає кореневий розділ; слот кабінету видимий завжди.
    if (selectors.length === 1 && selectors[0] === SLOT && body.trim() === 'display: none;') return null;
    return selectors.length ? selectors.join(',\n') + ' {' + body + '}' : null;
}

export function slotCss(css) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = splitTop(stripped).map(convertRule).filter(Boolean);
    return '/* Згенеровано scripts/gen-slot-css.mjs з crm.css — не редагувати руками (npm run gen:slot-css). */\n' + rules.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const src = fileURLToPath(new URL('../src/crm.css', import.meta.url));
    const out = fileURLToPath(new URL('../src/cabinet-slot.css', import.meta.url));
    fs.writeFileSync(out, slotCss(fs.readFileSync(src, 'utf8')));
    console.log('written', out);
}
