import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { SITE_DIR, siteFileList, syncSite } from './scripts/sync-site.mjs';
import { injectSite } from './scripts/site-html.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(APP_DIR, 'src/site-bridge.js');
// Ті самі rewrites, що в корені для сайту (vercel.json → rewrites).
export const LEGAL_REWRITES = { '/offer': '/legal/offer.html', '/privacy': '/legal/privacy.html', '/payment-refund': '/legal/payment-refund.html' };
// /api — на trip-control.com (як rewrite у vercel.json на Vercel): той самий origin для браузера, без CORS.
const API_PROXY = { '/api': { target: 'https://trip-control.com', changeOrigin: true, secure: true } };

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

// Dev: «/» — копія сайту з інжектом, /assets/** і /legal/** — з .site/, /offer… — rewrites.
function siteMiddleware(html) {
    return (req, res, next) => {
        let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
        pathname = LEGAL_REWRITES[pathname] || pathname;
        if (pathname === '/' || pathname === '/index.html') {
            res.setHeader('Content-Type', TYPES['.html']);
            res.setHeader('Cache-Control', 'no-cache');
            res.end(html());
            return;
        }
        const file = path.join(SITE_DIR, pathname);
        const inSite = file.startsWith(SITE_DIR + path.sep) && pathname !== '/index.html';
        if (!inSite || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
    };
}

function siteParity() {
    let bridgeFile = null;
    let bridgeCss = [];
    return {
        name: 'kontrol-plus-site',
        configureServer(server) {
            syncSite();
            const index = path.join(SITE_DIR, 'index.html');
            server.middlewares.use(siteMiddleware(() => injectSite(fs.readFileSync(index, 'utf8'), { js: '/src/site-bridge.js' })));
        },
        configurePreviewServer(server) {
            // dist/ уже містить сайт; лише «/» (appType custom не віддає index.html сам) і rewrites юридичних сторінок.
            const rewrites = { '/': '/index.html', ...LEGAL_REWRITES };
            server.middlewares.use((req, _res, next) => {
                const [pathname, query] = (req.url || '/').split('?');
                if (rewrites[pathname]) req.url = rewrites[pathname] + (query ? '?' + query : '');
                next();
            });
        },
        generateBundle(_options, bundle) {
            const entry = Object.values(bundle).find((chunk) => chunk.type === 'chunk' && chunk.isEntry && chunk.name === 'site-bridge');
            if (!entry) this.error('site-bridge entry not found in bundle');
            bridgeFile = '/' + entry.fileName;
            bridgeCss = [...(entry.viteMetadata ? entry.viteMetadata.importedCss : [])].map((file) => '/' + file);
            // Сайт — байт у байт із .site/ (його наповнює prebuild: scripts/sync-site.mjs), лише index.html з інжектом.
            for (const rel of siteFileList(SITE_DIR)) {
                const source = fs.readFileSync(path.join(SITE_DIR, rel));
                this.emitFile({
                    type: 'asset',
                    fileName: rel,
                    source: rel === 'index.html' ? injectSite(source.toString('utf8'), { js: bridgeFile, css: bridgeCss }) : source,
                });
            }
        },
    };
}

// Ключів Supabase у застосунку немає: CRM-вкладки беруть клієнт сайту (той самий publishable key, що й на trip-control.com).
export default defineConfig({
    appType: 'custom',
    plugins: [siteParity()],
    build: {
        target: 'es2020',
        sourcemap: false,
        // /assets/** зайнято сайтом; збірка Vite (хешовані файли) — у /kp-assets/.
        assetsDir: 'kp-assets',
        rollupOptions: { input: { 'site-bridge': BRIDGE } },
    },
    server: { port: 5174, proxy: API_PROXY },
    preview: { port: 4174, proxy: API_PROXY },
});
