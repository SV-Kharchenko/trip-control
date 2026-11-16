// Vercel Hobby: не більше 12 Serverless Functions у проєкті kontrol-plus (кожен api/**/*.js; імена з «_» не рахуються). Дубль перевірки
// з кореня (tests/function-limit.test.mjs), щоб `npm test` у apps/kontrol-plus теж падав, якщо хтось додасть 13-ту функцію.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('kontrol-plus: не більше 12 Serverless Functions (api/), AGRO SSO проксюється на сайт', () => {
    const files = fs.readdirSync(new URL('../api/', import.meta.url), { recursive: true }).map((f) => String(f).split(String.fromCharCode(92)).join('/'))
        .filter((f) => /\.(js|mjs|cjs|ts)$/.test(f) && !f.split('/').some((part) => part.startsWith('_')));
    assert.ok(files.length <= 12, files.length + ' функцій (ліміт Hobby 12): ' + files.join(', '));
    assert.equal(files.some((f) => f.startsWith('agro/')), false, 'agro/sso.js живе на сайті');
    const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.deepEqual(cfg.rewrites.find((r) => r.source === '/api/:path*'), { source: '/api/:path*', destination: 'https://trip-control.com/api/:path*' });
});
