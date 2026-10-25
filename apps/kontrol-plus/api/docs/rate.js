// POST /api/docs/rate — курс НБУ для документа (етап 4a). Статичний файл: реальний файл у api/ має пріоритет над
// rewrite /api/:path* → trip-control.com. Логіка — lib/docs/rate.js. Env (Vercel, проєкт kontrol-plus): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY — лише щоб перевірити JWT (auth.getUser); нових змінних середовища немає.
import { createClient } from '@supabase/supabase-js';
import { createRateHandler } from '../../lib/docs/rate.js';

let handler = null;

export default async function docsRate(req, res) {
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
            return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Курс НБУ ще не налаштовано на сервері.' });
        }
        const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        handler = createRateHandler({
            getUser: async (jwt) => {
                const { data, error } = await supabase.auth.getUser(jwt);
                return error || !data ? null : data.user;
            },
        });
    }
    return handler(req, res);
}
