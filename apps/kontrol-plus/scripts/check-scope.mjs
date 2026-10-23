// Гілка Контроль+ не змінює сайт: git diff від main (merge-base) поза apps/kontrol-plus/ має бути порожнім.
//   npm run check:scope [-- <база, за замовчуванням origin/main або main>]
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tryBase = (ref) => { try { git('rev-parse', '--verify', '--quiet', ref); return ref; } catch { return null; } };
const base = process.argv[2] || tryBase('origin/main') || tryBase('main');
if (!base) throw new Error('Немає main / origin/main — передайте базу аргументом');
const top = git('rev-parse', '--show-toplevel');
const mergeBase = git('merge-base', base, 'HEAD');
const outside = execFileSync('git', ['diff', '--name-only', mergeBase, '--', '.', ':!apps/kontrol-plus'], { cwd: top, encoding: 'utf8' })
    .split('\n').filter(Boolean);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '.', ':!apps/kontrol-plus'], { cwd: top, encoding: 'utf8' })
    .split('\n').filter(Boolean);
if (outside.length) {
    console.error(`Змінено файли поза apps/kontrol-plus/ відносно ${base} (${mergeBase.slice(0, 7)}):\n  ` + outside.join('\n  '));
    process.exit(1);
}
console.log(`check-scope: поза apps/kontrol-plus/ змін немає відносно ${base} (${mergeBase.slice(0, 7)})`
    + (untracked.length ? `; не в git (не входять у PR): ${untracked.join(', ')}` : ''));
