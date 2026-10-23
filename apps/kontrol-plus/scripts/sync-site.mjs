// Копіює сайт trip-control.com з кореня репозиторію в apps/kontrol-plus/.site/ байт у байт (prebuild / predev).
// Корінь лише читається: index.html, assets/**, legal/**, іконки. Інжект Контроль+ робиться потім і лише в dist/ (vite.config.js).
//   node scripts/sync-site.mjs [--from <корінь репо>] [--to <тека>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(APP_DIR, '../..');
export const SITE_DIR = path.join(APP_DIR, '.site');

// Те, на що посилається index.html сайту абсолютними шляхами (/assets/…, /offer → /legal/…, /favicon…).
export const SITE_FILES = ['index.html', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png'];
export const SITE_DIRS = ['assets', 'legal'];

export function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listFiles(dir, base = dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full, base));
        else if (entry.isFile()) out.push(path.relative(base, full));
    }
    return out;
}

// Відносні шляхи (з «/») усіх файлів сайту, що копіюються.
export function siteFileList(from = REPO_ROOT) {
    const missing = [...SITE_FILES, ...SITE_DIRS].filter((name) => !fs.existsSync(path.join(from, name)));
    if (missing.length) {
        throw new Error(`Сайт не знайдено поруч із застосунком (${from}): немає ${missing.join(', ')}. `
            + 'На Vercel увімкніть Settings → Build and Deployment → Root Directory → '
            + '«Include files outside the root directory in the Build Step» (див. README).');
    }
    const files = [...SITE_FILES];
    for (const dir of SITE_DIRS) files.push(...listFiles(path.join(from, dir)).map((rel) => path.join(dir, rel)));
    return files.map((rel) => rel.split(path.sep).join('/')).sort();
}

export function syncSite({ from = REPO_ROOT, to = SITE_DIR } = {}) {
    const files = siteFileList(from);
    fs.rmSync(to, { recursive: true, force: true });
    const copied = [];
    for (const rel of files) {
        const src = path.join(from, rel);
        const dest = path.join(to, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        const hash = sha256(dest);
        if (hash !== sha256(src)) throw new Error('Копія відрізняється від оригіналу: ' + rel);
        copied.push({ path: rel, sha256: hash });
    }
    return copied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = (name) => {
        const i = process.argv.indexOf(name);
        return i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
    };
    const copied = syncSite({ from: arg('--from'), to: arg('--to') });
    const index = copied.find((f) => f.path === 'index.html');
    console.log(`sync-site: ${copied.length} файлів сайту → .site/ (index.html sha256 ${index.sha256.slice(0, 12)})`);
}
