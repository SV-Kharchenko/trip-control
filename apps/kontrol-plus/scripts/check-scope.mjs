// Гілка Контроль+ не змінює сайт: git diff від main (merge-base) поза apps/kontrol-plus/ має бути порожнім.
// Винятки — вузький явний allowlist нижче: міграції етапів 2a (GPS) і 3a (ремонти і склад) та їхні pgTAP.
//   npm run check:scope [-- <база, за замовчуванням origin/main або main>]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Точні шаблони шляхів відносно кореня репо. Нічого ширшого (теки, інші міграції, docs/) сюди не додаємо.
export const SCOPE_ALLOWLIST = [
    /^supabase\/migrations\/\d{14}_gps_integrations\.sql$/,
    /^supabase\/tests\/gps_integrations\.sql$/,
    /^supabase\/migrations\/\d{14}_repairs_stock\.sql$/,
    /^supabase\/tests\/repairs_stock\.sql$/,
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
