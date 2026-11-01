// Скріншоти 1920×1080 для Microsoft Store: Огляд / Розрахунки / Клієнти / Документи.
// Playwright + власний Chromium (не системний Chrome). Потрібен вхід: див. store-screenshots/README.md. PNG лежать поза public/, щоб не потрапити в dist і коміт.
//   node scripts/store-screenshots.mjs --login                    # один раз: вхід вручну, зберігає сесію
//   node scripts/store-screenshots.mjs [--base https://app.trip-control.com]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(APP_DIR, 'store-screenshots');
const STATE = process.env.KP_STORAGE_STATE || path.join(APP_DIR, '.store-session.json');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const BASE = arg('--base', process.env.KP_BASE_URL || 'https://app.trip-control.com').replace(/\/+$/, '');

export const SHOTS = [
    { file: 'store-overview.png', hash: '#/cabinet', label: 'Огляд' },
    { file: 'store-calculations.png', hash: '#calculator', label: 'Розрахунки' },
    { file: 'store-clients.png', hash: '#/clients', label: 'Клієнти' },
    { file: 'store-documents.png', hash: '#/docs', label: 'Документи' }
];

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch {
        console.error('Playwright не встановлено. Виконайте: npm i --no-save playwright && npx playwright install chromium');
        process.exit(1);
    }
}

async function main() {
    const { chromium } = await loadPlaywright();
    if (args.includes('--login')) {
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
        const page = await context.newPage();
        await page.goto(BASE + '/');
        console.log('Увійдіть у відкритому вікні, дочекайтеся кабінету, потім натисніть Enter тут.');
        await new Promise((resolve) => process.stdin.once('data', resolve));
        await context.storageState({ path: STATE });
        await browser.close();
        console.log('Сесію збережено в', STATE, '(файл у .gitignore, не комітити).');
        return;
    }
    if (!fs.existsSync(STATE)) {
        console.error('Немає збереженої сесії (' + STATE + '). Спершу: node scripts/store-screenshots.mjs --login');
        process.exit(1);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, storageState: STATE, locale: 'uk-UA' });
    const page = await context.newPage();
    for (const shot of SHOTS) {
        await page.goto(BASE + '/' + shot.hash);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);
        const out = path.join(OUT_DIR, shot.file);
        await page.screenshot({ path: out, fullPage: false });
        console.log(shot.label, '→', path.relative(APP_DIR, out));
    }
    await browser.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
