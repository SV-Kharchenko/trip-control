import { createClient } from '@supabase/supabase-js';
import { isUuid, sendTelegram, shouldNotifySignup, signupMessage, statusKeyboard } from '../lib/signup-notify.js';

/**
 * POST /api/signup-notify { user_id }
 * Клієнт викликає після успішного signUp (сесії може ще не бути — email не підтверджено).
 * Сервер сам перевіряє, що акаунт щойно створений і про нього ще не сповіщали,
 * і шле власнику повідомлення в Telegram. Будь-яка помилка тут не ламає реєстрацію:
 * клієнт не чекає відповіді й ігнорує її.
 */
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const userId = req.body && req.body.user_id;
    if (!isUuid(userId)) return res.status(400).json({ ok: false });

    try {
        const { data, error } = await supabase.auth.admin.getUserById(userId);
        const user = data && data.user;
        if (error || !user) return res.status(200).json({ ok: false });
        if (!shouldNotifySignup(user)) return res.status(200).json({ ok: true, skipped: true });

        // Спершу позначка «вже сповіщено» — повторні виклики не дублюють повідомлення.
        const appMeta = Object.assign({}, user.app_metadata || {}, { signup_notified_at: new Date().toISOString() });
        const { error: markError } = await supabase.auth.admin.updateUserById(userId, { app_metadata: appMeta });
        if (markError) throw markError;

        let org = null;
        try {
            const { data: profile } = await supabase
                .from('profiles')
                .select('organizations(name, work_mode)')
                .eq('id', userId)
                .maybeSingle();
            org = profile && profile.organizations;
        } catch (e) {}

        // Кнопки статусу обробляє api/telegram-webhook.js.
        await sendTelegram(signupMessage(user, org), { fetch, env: process.env, replyMarkup: statusKeyboard(user.id) });
        return res.status(200).json({ ok: true });
    } catch (e) {
        console.warn('signup notify failed', e && (e.code || e.message));
        return res.status(200).json({ ok: false });
    }
}
