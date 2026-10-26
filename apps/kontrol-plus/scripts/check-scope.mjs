// Гілка Контроль+ не змінює сайт: git diff від main (merge-base) поза apps/kontrol-plus/ має бути порожнім.
// Винятки — вузький явний allowlist нижче: міграції етапів 2a (GPS), 3a (ремонти і склад), 3b (ТО і вартість на км),
// 4a (документи), 4b (ТТН) та їхні pgTAP; для 4b ще index.html (лише картка авто / автопарк: нові поля ТЗ і згортуваний
// блок ТО / страхування — рішення Свята від 26.10) і один корінний тест цієї картки; для вкладки «Історія рейсів» — той самий index.html і корінний tests/trip-history-tab.test.mjs. Для калькулятора на одній сторінці — той самий index.html і корінний tests/calc-onepage.test.mjs. Інші файли сайту закриті.
//   npm run check:scope [-- <база, за замовчуванням origin/main або main>]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Точні шаблони шляхів відносно кореня репо. Нічого ширшого (теки, інші міграції, docs/) сюди не додаємо.
export const SCOPE_ALLOWLIST = [
    /^supabase\/migrations\/\d{14}_gps_integrations\.sql$/,
    /^supabase\/tests\/gps_integrations\.sql$/,
    /^supabase\/migrations\/\d{14}_repairs_stock\.sql$/,
    /^supabase\/tests\/repairs_stock\.sql$/,
    /^supabase\/migrations\/\d{14}_repairs_maintenance\.sql$/,
    /^supabase\/tests\/repairs_maintenance\.sql$/,
    /^supabase\/migrations\/\d{14}_kp_documents\.sql$/,
    /^supabase\/tests\/kp_documents\.sql$/,
    /^supabase\/migrations\/\d{14}_kp_docs_ttn\.sql$/,
    /^supabase\/tests\/kp_docs_ttn\.sql$/,
    /^index\.html$/,
    /^tests\/fleet-ttn-fields\.test\.mjs$/,
    /^tests\/trip-history-tab\.test\.mjs$/,
    /^tests\/header-menu\.test\.mjs$/,
    /^tests\/calc-onepage\.test\.mjs$/,
];

export function isAllowedOutside(file) {
    return SCOPE_ALLOWLIST.some((re) => re.test(String(file)));
}

export function outsideScope(files) {
    return files.filter((f) => f && !f.startsWith('apps/kontrol-plus/') && !isAllowedOutside(f));
}

function main() {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const tryBase = (ref) => { try { git('rev-parse', '--verify', '--quiet', ref); return ref; } catch { return null; } };
    const base = process.argv[2] || tryBase('origin/main') || tryBase('main');
    if (!base) throw new Error('Немає main / origin/main — передайте базу аргументом');
    const top = git('rev-parse', '--show-toplevel');
    const mergeBase = git('merge-base', base, 'HEAD');
    // --no-renames: перейменування показується як видалення + додавання, тож обидва шляхи проходять перевірку.
    const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', mergeBase, '--', '.', ':!apps/kontrol-plus'], { cwd: top, encoding: 'utf8' })
        .split('\n').filter(Boolean);
    const outside = outsideScope(changed);
    const allowed = changed.filter(isAllowedOutside);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '.', ':!apps/kontrol-plus'], { cwd: top, encoding: 'utf8' })
        .split('\n').filter(Boolean);
    if (outside.length) {
        console.error(`Змінено файли поза apps/kontrol-plus/ відносно ${base} (${mergeBase.slice(0, 7)}):\n  ` + outside.join('\n  '));
        process.exit(1);
    }
    console.log(`check-scope: поза apps/kontrol-plus/ змін немає відносно ${base} (${mergeBase.slice(0, 7)})`
        + (allowed.length ? `; дозволено allowlist: ${allowed.join(', ')}` : '')
        + (untracked.length ? `; не в git (не входять у PR): ${untracked.join(', ')}` : ''));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
