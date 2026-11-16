// Vercel Hobby: не більше 12 Serverless Functions на деплой (проєкт). Кожен файл api/**/*.js (крім імен, що починаються з «_») — окрема функція,
// [param].js теж одна. Деплой Preview падає на «Deploying outputs», хоч збірка зелена, якщо ліміт перевищено. Перевіряємо обидва проєкти:
// сайт trip-control (корінь, api/) і Контроль+ (apps/kontrol-plus/api/). Нову функцію КП додавати в існуючу або на сайт (КП проксює /api/*).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

export const HOBBY_FUNCTION_LIMIT = 12;

function functionsIn(dir) {
    const root = new URL('../' + dir + '/', import.meta.url);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { recursive: true })
        .map((f) => String(f).replace(/\\/g, '/'))
        .filter((f) => /\.(js|mjs|cjs|ts)$/.test(f) && !f.split('/').some((part) => part.startsWith('_')))
        .sort();
}

for (const [project, dir] of [['trip-control (сайт)', 'api'], ['kontrol-plus', 'apps/kontrol-plus/api']]) {
    test('Vercel Hobby: у ' + project + ' не більше ' + HOBBY_FUNCTION_LIMIT + ' Serverless Functions (' + dir + '/)', () => {
        const files = functionsIn(dir);
        assert.ok(files.length > 0, 'знайдено функції в ' + dir);
        assert.ok(files.length <= HOBBY_FUNCTION_LIMIT, dir + ': ' + files.length + ' функцій (ліміт ' + HOBBY_FUNCTION_LIMIT + '): ' + files.join(', '));
    });
}

test('AGRO SSO — функція сайту, а не kontrol-plus (там усі 12 місць зайняті)', () => {
    assert.ok(functionsIn('api').includes('agro/sso.js'));
    assert.equal(functionsIn('apps/kontrol-plus/api').some((f) => f.startsWith('agro/')), false);
});
