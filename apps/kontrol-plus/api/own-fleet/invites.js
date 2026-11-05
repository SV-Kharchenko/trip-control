// POST /api/own-fleet/invites — запрошення замовника підрозділу («Власний парк», етап 1). Статичний файл: реальний файл у api/ має
// пріоритет над rewrite /api/:path* → trip-control.com. Логіка — lib/own-fleet/invites.js.
// Env (Vercel, проєкт kontrol-plus): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; RESEND_API_KEY і INVITE_FROM_EMAIL — необовʼязково
// (без них — «Скопіювати посилання»).
import { createClient } from '@supabase/supabase-js';
import { createOwnFleetInvitesHandler, createOwnFleetStore } from '../../lib/own-fleet/invites.js';

let handler = null;

export default async function ownFleetInvites(req, res) {
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
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Запрошення ще не налаштовано на сервері.' });
        const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        handler = createOwnFleetInvitesHandler({ store: createOwnFleetStore(supabase), env: process.env, fetch: globalThis.fetch });
    }
    return handler(req, res);
}
