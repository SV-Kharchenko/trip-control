// Порівнює Vercel preview сайту з продом після кореневого .vercelignore. Лише GET, без побічних ефектів.
//   VERCEL_AUTOMATION_BYPASS_SECRET=... node apps/kontrol-plus/scripts/preview-check.mjs https://<preview>.vercel.app
import crypto from 'node:crypto';

const PREVIEW = process.argv[2].replace(/\/+$/, '');
const PROD = 'https://trip-control.com';
const hidden = ['/supabase/README.md', '/docs/ROLES.md', '/docs/SECRETS.md', '/apps/kontrol-plus/README.md',
    '/apps/kontrol-plus/db/check-db.mjs', '/scripts/check-security-grants.mjs', '/tests/pwa.test.mjs', '/SECURITY-FIX-PLAN.md',
    '/supabase/migrations/20261022090000_kontrol_plus_access.sql'];
const same = ['/', '/offer', '/privacy', '/payment-refund', '/legal/offer.html', '/404.html', '/offline.html', '/sw.js', '/site.webmanifest',
    '/favicon.ico', '/favicon-32.png', '/apple-touch-icon.png', '/robots.txt', '/sitemap.xml',
    '/assets/landing.css', '/assets/landing.js', '/assets/cost-hints.js', '/assets/legal-footer.css', '/assets/brand/icon-192.png',
    '/assets/logo-trip-control.png', '/api/calculate', '/api/team', '/api/admin'];

async function get(base, path) {
    const headers = { 'user-agent': 'trip-control-preview-check' };
    // Vercel → Settings → Deployment Protection → Protection Bypass for Automation (preview only).
    if (base === PREVIEW && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const res = await fetch(base + path, { redirect: 'manual', headers });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0],
        hash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12), size: body.length, text: body.toString('utf8', 0, 300) };
}

let failed = 0;
const rows = [];
for (const path of hidden) {
    const p = await get(PREVIEW, path);
    const pr = await get(PROD, path);
    const ok = p.status === 404;
    if (!ok) failed += 1;
    rows.push(`${ok ? 'PASS' : 'FAIL'} hidden ${path}: preview ${p.status} (prod today ${pr.status})`);
}
for (const path of same) {
    const p = await get(PREVIEW, path);
    const pr = await get(PROD, path);
    // HTML pages may embed per-deploy values; compare status + type always, bytes for static files.
    const isApi = path.startsWith('/api/');
    const bytes = p.hash === pr.hash;
    const ok = p.status === pr.status && p.type === pr.type && (isApi || bytes || p.type === 'text/html');
    if (!ok) failed += 1;
    rows.push(`${ok ? 'PASS' : 'FAIL'} same ${path}: preview ${p.status} ${p.type} ${p.size}B ${p.hash} | prod ${pr.status} ${pr.type} ${pr.size}B ${pr.hash}${bytes ? ' (identical)' : ''}`
        + (isApi ? ` | preview body ${JSON.stringify(p.text.slice(0, 80))}` : ''));
}
console.log(rows.join('\n'));
console.log(failed ? failed + ' failed' : 'all preview checks passed');
