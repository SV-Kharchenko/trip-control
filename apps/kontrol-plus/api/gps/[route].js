// Vercel Function проєкту Контроль+: POST /api/gps/{connect|test|sync-units|disconnect}.
// Файл у api/ має пріоритет над rewrite /api/:path* → trip-control.com (vercel.json): решта /api/* іде на сайт.
// Env (Vercel, проєкт kontrol-plus): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Без них — 503, нічого не робимо.
import { createClient } from '@supabase/supabase-js';
import { createGpsHandler } from '../../lib/gps/api.js';
import { createSupabaseStore } from '../../lib/gps/store.js';

let handler = null;

export default async function gpsRoute(req, res) {
    if (!handler) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'GPS ще не налаштовано на сервері.' });
        }
        const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        handler = createGpsHandler({ store: createSupabaseStore(supabase) });
    }
    return handler(req, res);
}
