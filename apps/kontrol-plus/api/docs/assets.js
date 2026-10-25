// POST /api/docs/assets — знімок підпису й печатки перед створенням документа (етап 4a). Статичний файл: реальний файл
// у api/ має пріоритет над rewrite /api/:path* → trip-control.com. Логіка — lib/docs/assets.js. Env (Vercel, проєкт
// kontrol-plus): ті самі SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — перевірка JWT, RPC kp_doc_assets_source від імені
// користувача (його JWT в Authorization) і копія в бакеті kp-doc-assets; нових змінних середовища немає.
import { createClient } from '@supabase/supabase-js';
import { createAssetsHandler } from '../../lib/docs/assets.js';

const BUCKET = 'kp-doc-assets';
const NO_SESSION = { persistSession: false, autoRefreshToken: false };
let handler = null;

export default async function docsAssets(req, res) {
    // Метод і наявність JWT — до env: запит без входу завжди 401 від Контроль+.
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
    }
    const auth = String((req.headers && req.headers.authorization) || '');
    if (!auth.startsWith('Bearer ') || auth.length <= 7) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'Потрібно увійти.' });
    }
    if (!handler) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Підпис і печатку для документів ще не налаштовано на сервері.' });
        }
        const supabase = createClient(url, key, { auth: NO_SESSION });
        handler = createAssetsHandler({
            getUser: async (jwt) => {
                const { data, error } = await supabase.auth.getUser(jwt);
                return error || !data ? null : data.user;
            },
            getSource: async (jwt) => {
                const asUser = createClient(url, key, { auth: NO_SESSION, global: { headers: { Authorization: 'Bearer ' + jwt } } });
                const { data, error } = await asUser.rpc('kp_doc_assets_source');
                if (error) throw new Error(String(error.message || 'source'));
                return Array.isArray(data) ? data[0] || null : data;
            },
            copy: async (from, to) => {
                const { error } = await supabase.storage.from(BUCKET).copy(from, to);
                if (error) {
                    const notFound = /not.?found/i.test(String(error.message || '')) || String(error.statusCode || error.status) === '404';
                    throw Object.assign(new Error('COPY_FAILED'), { code: 'COPY_FAILED', notFound });
                }
            },
        });
    }
    return handler(req, res);
}
