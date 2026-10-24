// Обгортка Vercel Function для api/gps/{connect,test,sync-units,disconnect}.js (статичні файли, спільний хендлер).
// Env (Vercel, проєкт kontrol-plus): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Без них — 503, нічого не робимо.
import { createClient } from '@supabase/supabase-js';
import { createGpsHandler } from './api.js';
import { createSupabaseStore } from './store.js';

let handler = null;

export function gpsVercelRoute(route) {
    return async function gpsRoute(req, res) {
        // Метод і наявність JWT — до env: запит без входу завжди 401 від Контроль+ (так і перевіряється маршрутизація).
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
                res.setHeader('Cache-Control', 'no-store');
                return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'GPS ще не налаштовано на сервері.' });
            }
            const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
            handler = createGpsHandler({ store: createSupabaseStore(supabase) });
        }
        return handler(req, res, route);
    };
}
