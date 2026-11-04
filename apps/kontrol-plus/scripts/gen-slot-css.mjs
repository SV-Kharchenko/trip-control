// Стилі розділів Контроль+ у слотах «Особистого кабінету» (Реквізити, Статистика). Усі правила crm.css прив'язані до #kp-crm,
// а слоти лежать в #cabinet-screen поза ним, тож з crm.css генерується копія з тим самим набором правил для `#cabinet-screen .cab-slot`.
// Правила про лівий бік меню, шапку й сторінку сайту (#main-app, #kp-side, #kp-toast, kp-nav, data-kp-view) не копіюються.
//   node scripts/gen-slot-css.mjs          — переписати src/cabinet-slot.css
//   tests/cabinet-slots.test.mjs           — падає, якщо файл застарів
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SLOT = '#cabinet-screen .cab-slot';
// Вікна Контроль+ лежать у <body>, поза #kp-crm, тож без копії правил форм, кнопок і таблиць (crm.css) у них нічого не діє.
export const WIN = 'body.kp-shell-on .kp-win';
const WIN_DARK = 'body[data-theme="dark"].kp-shell-on .kp-win';
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

function convertSelectors(list, target) {
    const kept = list.split(',').map((s) => s.trim()).filter((s) => s.includes('#kp-crm') && !SKIP.test(s));
    if (target === WIN) return kept.map((s) => s.replace(/^body\[data-theme="dark"\] #kp-crm/, WIN_DARK).replace(/#kp-crm/g, WIN));
    return kept.map((s) => s.replace(/#kp-crm/g, target));
}

function convertRule(rule, target = SLOT) {
    const open = rule.indexOf('{');
    const head = rule.slice(0, open).trim();
    const body = rule.slice(open + 1, rule.lastIndexOf('}'));
    if (head.startsWith('@keyframes') || head.startsWith('@font-face')) return null;
    if (head.startsWith('@media') || head.startsWith('@supports')) {
        const inner = splitTop(body).map((r) => convertRule(r, target)).filter(Boolean);
        return inner.length ? head + ' {\n' + inner.map((r) => '  ' + r.replace(/\n/g, '\n  ')).join('\n') + '\n}' : null;
    }
    const selectors = convertSelectors(head, target);
    // `#kp-crm { display: none }` ховає кореневий розділ; слот кабінету видимий завжди.
    if (selectors.length === 1 && selectors[0] === target && body.trim() === 'display: none;') return null;
    // Корінь вікна — його рамка (kp-windows.css): відступи й колір кореня розділу (`#kp-crm { color; padding }`) не копіюються.
    // Палітру (--bg, --accent…) не дублюємо: вікно й діалог названі прямо в палітрі crm.css.
    if (target === WIN && selectors.length === 1 && selectors[0] === WIN) return null;
    return selectors.length ? selectors.join(',\n') + ' {' + body + '}' : null;
}

export function slotCss(css, target = SLOT) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = splitTop(stripped).map((r) => convertRule(r, target)).filter(Boolean);
    return '/* Згенеровано scripts/gen-slot-css.mjs з crm.css — не редагувати руками (npm run gen:slot-css). */\n' + rules.join('\n') + '\n';
}

// Копія для вікон: ті самі правила crm.css під `body.kp-shell-on .kp-win` (вікна є лише в Контроль+ від 900px).
export function winCss(css) {
    return slotCss(css, WIN);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const src = fileURLToPath(new URL('../src/crm.css', import.meta.url));
    const out = fileURLToPath(new URL('../src/cabinet-slot.css', import.meta.url));
    const outWin = fileURLToPath(new URL('../src/kp-win-scope.css', import.meta.url));
    const crm = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(out, slotCss(crm));
    fs.writeFileSync(outWin, winCss(crm));
    console.log('written', out, outWin);
}
