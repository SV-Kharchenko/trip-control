import { timingSafeEqual } from 'node:crypto';
import { userAccessStatus } from './account-block.js';
import { statusKeyboard, telegramApi, telegramConfig } from './signup-notify.js';
import { setUserStatus, USER_STATUS_LABEL, UserStatusError } from './user-status.js';

// Керування користувачами з Telegram-бота. Вебхук: api/telegram-webhook.js.
// Приймає апдейти лише з чату власника (TELEGRAM_CHAT_ID), решту мовчки ігнорує.
// Відповіді в чат короткі: без стектрейсів, токенів і внутрішніх повідомлень БД.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CALLBACK_RE = new RegExp('^st:(full|demo|blocked):(' + UUID + ')$', 'i');
const LIST_CALLBACK_RE = /^ul:(all|demo|full|blocked|new):([1-9][0-9]{0,3})$/;
const OPEN_CALLBACK_RE = new RegExp('^ui:(' + UUID + ')$', 'i');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const USER_LOOKUP_PAGES = 20;
const USER_LOOKUP_PER_PAGE = 1000;
const DB_PAGE = 1000; // PostgREST віддає не більше 1000 рядків за запит

export const USER_FILTERS = ['all', 'demo', 'full', 'blocked', 'new'];
export const USERS_PAGE_SIZE = 10;
export const NEW_USER_DAYS = 7;

export const BOT_COMMANDS = [
    { command: 'users', description: 'Список користувачів: /users [all|demo|full|blocked|new]' },
    { command: 'user', description: 'Картка користувача: /user <email>' },
    { command: 'help', description: 'Список команд' }
];

export const HELP_TEXT = [
    'Команди:',
    '/users [all|demo|full|blocked|new] — список користувачів, по ' + USERS_PAGE_SIZE + ' на сторінку, нові зверху.',
    '  all — усі (за замовчуванням), demo / full / blocked — за статусом, new — зареєстровані за ' + NEW_USER_DAYS + ' днів.',
    '/user <email> — картка користувача з кнопками статусу.',
    '/help — цей список.'
].join('\n');

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

// /users [filter] → { filter } або { error }. Без аргументу — all.
export function parseUsersCommand(text) {
    const match = /^\/users(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(String(text || '').trim());
    if (!match) return null;
    const filter = (match[1] || 'all').toLowerCase();
    if (!USER_FILTERS.includes(filter)) return { error: 'Фільтр: ' + USER_FILTERS.join(', ') + '. Напр. /users demo' };
    return { filter };
}

// callback_data → { kind, … } або null для всього, що не пройшло валідацію.
export function parseCallbackData(data) {
    const value = String(data || '');
    let m = CALLBACK_RE.exec(value);
    if (m) return { kind: 'status', status: m[1].toLowerCase(), userId: m[2].toLowerCase() };
    m = LIST_CALLBACK_RE.exec(value);
    if (m) return { kind: 'list', filter: m[1], page: Number(m[2]) };
    m = OPEN_CALLBACK_RE.exec(value);
    if (m) return { kind: 'open', userId: m[1].toLowerCase() };
    return null;
}

async function listAllAuthUsers(supabase) {
    const all = [];
    for (let page = 1; page <= USER_LOOKUP_PAGES; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USER_LOOKUP_PER_PAGE });
        if (error) throw error;
        const users = (data && data.users) || [];
        all.push(...users);
        if (users.length < USER_LOOKUP_PER_PAGE) break;
    }
    return all;
}

// Усі рядки запиту пачками по 1000 (обмеження PostgREST), а не по запиту на юзера.
async function selectAllRows(makeQuery) {
    const rows = [];
    for (let from = 0; ; from += DB_PAGE) {
        const { data, error } = await makeQuery().range(from, from + DB_PAGE - 1);
        if (error) throw error;
        const chunk = data || [];
        rows.push(...chunk);
        if (chunk.length < DB_PAGE) return rows;
    }
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

async function cardFor(supabase, user) {
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

export async function userCard(supabase, email) {
    const user = await findUserByEmail(supabase, email);
    if (!user) return { text: 'Користувача ' + email + ' не знайдено.' };
    return cardFor(supabase, user);
}

export async function userCardById(supabase, userId) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) throw error;
    const user = data && data.user;
    if (!user) return { text: 'Користувача не знайдено.' };
    return cardFor(supabase, user);
}

function listStatusLabel(row) {
    return row.isAdmin ? 'Адміністратор' : USER_STATUS_LABEL[row.status];
}

function matchesFilter(row, filter, nowMs) {
    if (filter === 'all') return true;
    if (filter === 'new') return nowMs - row.createdMs <= NEW_USER_DAYS * 24 * 60 * 60 * 1000;
    return row.status === filter;
}

// Сторінка списку: 1 запит до Auth (пачками), 1 до profiles (пачками), 1 до calculations для 10 юзерів сторінки.
export async function usersPage(supabase, filter, page, nowMs) {
    const [authUsers, profiles] = await Promise.all([
        listAllAuthUsers(supabase),
        selectAllRows(() => supabase.from('profiles').select('id, role, is_approved').order('id'))
    ]);
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const rows = authUsers
        .map((u) => {
            const profile = profileById.get(u.id) || null;
            const createdMs = Date.parse(u.created_at);
            return {
                id: u.id,
                email: String(u.email || '—'),
                createdAt: u.created_at,
                createdMs: Number.isFinite(createdMs) ? createdMs : 0,
                isAdmin: !!(profile && profile.role === 'admin'),
                status: userAccessStatus(u, profile)
            };
        })
        .sort((a, b) => b.createdMs - a.createdMs || a.email.localeCompare(b.email));

    const totals = { all: rows.length, full: 0, demo: 0, blocked: 0 };
    rows.forEach((r) => { totals[r.status] += 1; });

    const filtered = rows.filter((r) => matchesFilter(r, filter, nowMs));
    const pages = Math.max(1, Math.ceil(filtered.length / USERS_PAGE_SIZE));
    const current = Math.min(Math.max(1, page), pages);
    const slice = filtered.slice((current - 1) * USERS_PAGE_SIZE, current * USERS_PAGE_SIZE);

    const counts = new Map(slice.map((r) => [r.id, 0]));
    if (slice.length) {
        const ids = slice.map((r) => r.id);
        const calcRows = await selectAllRows(() => supabase.from('calculations').select('user_id').in('user_id', ids).order('id'));
        calcRows.forEach((c) => { if (counts.has(c.user_id)) counts.set(c.user_id, counts.get(c.user_id) + 1); });
    }

    const lines = [
        '👥 Користувачі',
        'Всього ' + totals.all + ' · Повний ' + totals.full + ' · Демо ' + totals.demo + ' · Заблоковано ' + totals.blocked
    ];
    if (filter !== 'all') lines.push('Фільтр: ' + filter + ' · знайдено ' + filtered.length);
    lines.push('');
    if (!slice.length) lines.push('Нікого не знайдено.');
    slice.forEach((r, i) => {
        lines.push(((current - 1) * USERS_PAGE_SIZE + i + 1) + '. ' + r.email + ' · ' + listStatusLabel(r) +
            ' · розрахунків ' + counts.get(r.id) + ' · ' + (r.createdAt ? formatKyivDate(r.createdAt) : '—'));
    });

    const keyboard = slice.map((r) => [{
        text: (r.isAdmin ? '👑 ' : '👤 ') + r.email.slice(0, 48),
        callback_data: 'ui:' + r.id
    }]);
    const nav = [];
    if (current > 1) nav.push({ text: '◀', callback_data: 'ul:' + filter + ':' + (current - 1) });
    nav.push({ text: 'Сторінка ' + current + '/' + pages, callback_data: 'ul:' + filter + ':' + current });
    if (current < pages) nav.push({ text: '▶', callback_data: 'ul:' + filter + ':' + (current + 1) });
    keyboard.push(nav);

    return { text: lines.join('\n'), replyMarkup: { inline_keyboard: keyboard }, page: current, pages, filtered: filtered.length };
}

async function handleStatusCallback(ctx, query, parsed) {
    const { supabase, api, now } = ctx;
    const { status, userId } = parsed;
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
    // Підсумок замість кнопок: повторна зміна — через /user <email>.
    // При помилці вище повідомлення не редагується, тож кнопки лишаються.
    const message = query.message || {};
    try {
        await api('editMessageText', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            text: withStatusLine(message.text, status, now()),
            reply_markup: { inline_keyboard: [] }
        });
    } catch (e) {
        // Статус уже змінено; невдале редагування повідомлення його не відкочує.
        console.warn('telegram edit failed', e && (e.code || e.name));
    }
}

async function handleListCallback(ctx, query, parsed) {
    const { supabase, api, now } = ctx;
    const message = query.message || {};
    let list;
    try {
        list = await usersPage(supabase, parsed.filter, parsed.page, now());
    } catch (e) {
        console.warn('telegram users list failed', e && (e.code || e.name));
        await api('answerCallbackQuery', { callback_query_id: query.id, text: 'Не вдалося отримати список. Спробуйте пізніше.', show_alert: true });
        return;
    }
    await api('answerCallbackQuery', { callback_query_id: query.id });
    try {
        await api('editMessageText', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            text: list.text,
            reply_markup: list.replyMarkup,
            disable_web_page_preview: true
        });
    } catch (e) {
        // Напр. «message is not modified» на кнопці поточної сторінки.
        console.warn('telegram list edit failed', e && (e.code || e.name));
    }
}

async function handleOpenCallback(ctx, query, parsed) {
    const { supabase, api } = ctx;
    const message = query.message || {};
    let card;
    try {
        card = await userCardById(supabase, parsed.userId);
    } catch (e) {
        console.warn('telegram user card failed', e && (e.code || e.name));
        await api('answerCallbackQuery', { callback_query_id: query.id, text: 'Не вдалося отримати дані користувача. Спробуйте пізніше.', show_alert: true });
        return;
    }
    await api('answerCallbackQuery', { callback_query_id: query.id });
    const payload = { chat_id: message.chat.id, text: card.text, disable_web_page_preview: true };
    if (card.replyMarkup) payload.reply_markup = card.replyMarkup;
    await api('sendMessage', payload);
}

async function handleCallback(ctx, query) {
    const parsed = parseCallbackData(query.data);
    if (!parsed) {
        await ctx.api('answerCallbackQuery', { callback_query_id: query.id, text: 'Невідома дія.' });
        return;
    }
    if (parsed.kind === 'status') return handleStatusCallback(ctx, query, parsed);
    if (parsed.kind === 'list') return handleListCallback(ctx, query, parsed);
    return handleOpenCallback(ctx, query, parsed);
}

async function handleUsersCommand(ctx, chatId, command) {
    const { supabase, api, now } = ctx;
    if (command.error) {
        await api('sendMessage', { chat_id: chatId, text: command.error });
        return;
    }
    let list;
    try {
        list = await usersPage(supabase, command.filter, 1, now());
    } catch (e) {
        console.warn('telegram users list failed', e && (e.code || e.name));
        await api('sendMessage', { chat_id: chatId, text: 'Не вдалося отримати список. Спробуйте пізніше.' });
        return;
    }
    await api('sendMessage', { chat_id: chatId, text: list.text, reply_markup: list.replyMarkup, disable_web_page_preview: true });
}

async function handleMessage(ctx, message) {
    const { supabase, api } = ctx;
    const chatId = message.chat.id;
    const usersCommand = parseUsersCommand(message.text);
    if (usersCommand) return handleUsersCommand(ctx, chatId, usersCommand);
    const command = parseUserCommand(message.text);
    if (!command) {
        // /help, /start і будь-який інший текст — список команд.
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
