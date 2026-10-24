// POST /api/repairs/invites — запрошення менеджера з ремонтів (етап 3a). Статичний файл: реальний файл у api/ має
// пріоритет над rewrite /api/:path* → trip-control.com. Логіка — lib/repairs/invites.js.
// Env (Vercel, проєкт kontrol-plus): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KP_INVITE_SIGNING_SECRET;
// RESEND_API_KEY і INVITE_FROM_EMAIL — необовʼязково (без них — «Скопіювати посилання»).
import { createClient } from '@supabase/supabase-js';
import { createRepairInvitesHandler } from '../../lib/repairs/invites.js';
import { createRepairsStore } from '../../lib/repairs/store.js';

let handler = null;

export default async function repairInvites(req, res) {
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
        const secret = process.env.KP_INVITE_SIGNING_SECRET;
        if (!url || !key || !secret) {
            return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Запрошення ще не налаштовано на сервері.' });
        }
        const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
        handler = createRepairInvitesHandler({ store: createRepairsStore(supabase), secret, env: process.env, fetch: globalThis.fetch });
    }
    return handler(req, res);
}
