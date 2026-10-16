import { timingSafeEqual } from 'node:crypto';
import { userAccessStatus } from './account-block.js';
import { statusKeyboard, telegramApi, telegramConfig } from './signup-notify.js';
import { setUserStatus, USER_STATUS_LABEL, UserStatusError } from './user-status.js';

// Керування користувачами з Telegram-бота. Вебхук: api/telegram-webhook.js.
// Приймає апдейти лише з чату власника (TELEGRAM_CHAT_ID), решту мовчки ігнорує.
// Відповіді в чат короткі: без стектрейсів, токенів і внутрішніх повідомлень БД.

const CALLBACK_RE = /^st:(full|demo|blocked):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const USER_LOOKUP_PAGES = 20;
const USER_LOOKUP_PER_PAGE = 1000;

export const HELP_TEXT = 'Команди:\n/user <email> — картка користувача з кнопками статусу.';

export function formatKyivTime(at) {
    return new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kiev',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(at));
}

export function formatKyivDate(at) {
    return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kiev', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(at));
}

// Замінює рядок «Статус: …» у тексті повідомлення (або додає його в кінець).
export function withStatusLine(text, status, at) {
    const lines = String(text || '').split('\n').filter((line) => !/^Статус: /.test(line));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', 'Статус: ' + (USER_STATUS_LABEL[status] || status) + ' · ' + formatKyivTime(at));
    return lines.join('\n');
}

export function secretMatches(header, secret) {
    if (!secret || typeof header !== 'string') return false;
    const a = Buffer.from(header);
    const b = Buffer.from(String(secret));
    return a.length === b.length && timingSafeEqual(a, b);
}

// Лише чат власника і лише від самого власника: chat.id і from.id дорівнюють TELEGRAM_CHAT_ID.
export function isOwnerChat(update, ownerChatId) {
    if (!ownerChatId) return false;
    const source = update && (update.callback_query || update.message);
    if (!source) return false;
    const chat = update.callback_query ? source.message && source.message.chat : source.chat;
    if (!chat || String(chat.id) !== String(ownerChatId)) return false;
    // Діє лише сам власник, у будь-якому типі чату: інші учасники групи отримують тишу.
    return !!source.from && String(source.from.id) === String(ownerChatId);
}

export function parseUserCommand(text) {
    const match = /^\/user(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(String(text || '').trim());
    if (!match) return null;
    return { email: (match[1] || '').toLowerCase() };
}

async function findUserByEmail(supabase, email) {
    for (let page = 1; page <= USER_LOOKUP_PAGES; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USER_LOOKUP_PER_PAGE });
        if (error) throw error;
        const users = (data && data.users) || [];
        const found = users.find((u) => String(u.email || '').toLowerCase() === email);
        if (found) return found;
        if (users.length < USER_LOOKUP_PER_PAGE) return null;
    }
    return null;
}

export async function userCard(supabase, email) {
    const user = await findUserByEmail(supabase, email);
    if (!user) return { text: 'Користувача ' + email + ' не знайдено.' };

    const { data: profile } = await supabase
        .from('profiles')
        .select('id, org_id, role, is_approved')
        .eq('id', user.id)
        .maybeSingle();
    let orgName = '—';
    if (profile && profile.org_id) {
        const { data: org } = await supabase.from('organizations').select('name').eq('id', profile.org_id).maybeSingle();
        if (org && org.name) orgName = String(org.name).slice(0, 100);
    }
    const { count } = await supabase
        .from('calculations')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);

    const isAdmin = !!(profile && profile.role === 'admin');
    const status = userAccessStatus(user, profile);
    const lines = [
        '👤 Користувач',
        'Email: ' + (user.email || '—'),
        'Компанія: ' + orgName,
        'Розрахунків: ' + (Number.isFinite(count) ? count : 0),
        'Зареєстровано: ' + (user.created_at ? formatKyivDate(user.created_at) : '—'),
        '',
        'Статус: ' + (isAdmin ? 'Адміністратор (не змінюється)' : USER_STATUS_LABEL[status])
    ];
    return { text: lines.join('\n'), replyMarkup: isAdmin ? null : statusKeyboard(user.id) };
}

async function handleCallback(ctx, query) {
    const { supabase, api, now } = ctx;
    const match = CALLBACK_RE.exec(String(query.data || ''));
    if (!match) {
        await api('answerCallbackQuery', { callback_query_id: query.id, text: 'Невідома дія.' });
        return;
    }
    const status = match[1].toLowerCase();
    const userId = match[2].toLowerCase();
    try {
        await setUserStatus(supabase, {
            userId,
            status,
            actor: null,
            source: 'telegram',
            detail: { telegram_user_id: query.from && query.from.id }
        });
    } catch (e) {
        const text = e instanceof UserStatusError ? e.message : 'Не вдалося змінити статус. Спробуйте ще раз.';
        if (!(e instanceof UserStatusError)) console.warn('telegram set status failed', e && (e.code || e.name));
        await api('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: true });
        return;
    }
    await api('answerCallbackQuery', { callback_query_id: query.id, text: 'Статус: ' + USER_STATUS_LABEL[status] });
    const message = query.message || {};
    try {
        await api('editMessageText', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            text: withStatusLine(message.text, status, now()),
            reply_markup: statusKeyboard(userId)
        });
    } catch (e) {
        // Напр. «message is not modified» при повторному натисканні в ту ж хвилину. Статус уже змінено.
        console.warn('telegram edit failed', e && (e.code || e.name));
    }
}

async function handleMessage(ctx, message) {
    const { supabase, api } = ctx;
    const chatId = message.chat.id;
    const command = parseUserCommand(message.text);
    if (!command) {
        await api('sendMessage', { chat_id: chatId, text: HELP_TEXT });
        return;
    }
    if (!EMAIL_RE.test(command.email)) {
        await api('sendMessage', { chat_id: chatId, text: 'Вкажіть email: /user name@example.com' });
        return;
    }
    let card;
    try {
        card = await userCard(supabase, command.email);
    } catch (e) {
        console.warn('telegram user card failed', e && (e.code || e.name));
        await api('sendMessage', { chat_id: chatId, text: 'Не вдалося отримати дані користувача. Спробуйте пізніше.' });
        return;
    }
    const payload = { chat_id: chatId, text: card.text, disable_web_page_preview: true };
    if (card.replyMarkup) payload.reply_markup = card.replyMarkup;
    await api('sendMessage', payload);
}

// deps: { supabase (service role), fetch, env, now }
export function createTelegramWebhookHandler(deps) {
    const env = deps.env || process.env;
    const now = deps.now || (() => Date.now());
    const api = (method, payload) => telegramApi(method, payload, { fetch: deps.fetch, env });

    return async function handler(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
        const header = req.headers && req.headers['x-telegram-bot-api-secret-token'];
        if (!secretMatches(header, env.TELEGRAM_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

        let update = req.body;
        if (typeof update === 'string') {
            try { update = JSON.parse(update); } catch (e) { update = null; }
        }
        const config = telegramConfig(env);
        if (!config || !update || !isOwnerChat(update, config.chatId)) return res.status(200).json({ ok: true });

        const ctx = { supabase: deps.supabase, api, now };
        try {
            if (update.callback_query) await handleCallback(ctx, update.callback_query);
            else if (update.message && typeof update.message.text === 'string') await handleMessage(ctx, update.message);
        } catch (e) {
            // Відповідь Telegram завжди 200, інакше він повторюватиме апдейт.
            console.warn('telegram webhook failed', e && (e.code || e.name));
        }
        return res.status(200).json({ ok: true });
    };
}
