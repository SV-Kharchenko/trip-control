// POST /api/agro/sso — разовий підписаний токен для входу в AGRO без повторного логіну. Статичний файл: реальний файл у api/ має
// пріоритет над rewrite /api/:path* → trip-control.com. Логіка — lib/agro/sso.js.
// Env (Vercel, проєкт kontrol-plus): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AGRO_SSO_SECRET (≥ 32 символи); AGRO_APP_URL — необов'язково.
import { createClient } from '@supabase/supabase-js';
import { createAgroSsoHandler, createAgroStore, ssoConfig } from '../../lib/agro/sso.js';

let handler = null;

export default async function agroSso(req, res) {
    // Метод і наявність JWT — до env: запит без входу завжди 401.
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
        if (!ssoConfig(process.env)) return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Вхід в AGRO ще не налаштовано на сервері.' });
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        handler = createAgroSsoHandler({ store: createAgroStore(supabase), env: process.env });
    }
    return handler(req, res);
}
