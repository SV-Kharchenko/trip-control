// Telegram-сповіщення власнику про нову реєстрацію. Лише сервер (api/signup-notify.js);
// токен бота ніколи не потрапляє в браузер. Помилка відправки не впливає на реєстрацію.

export const SIGNUP_NOTIFY_WINDOW_MS = 15 * 60 * 1000;

const WORK_MODE_LABEL = { solo: 'Сам', team: 'З логістами' };
const OWNERSHIP_LABEL = { fop: 'ФОП', tov: 'ТОВ', other: 'Інше' };

function clean(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max || 120);
}

// Vercel env: TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID.
export function telegramConfig(env) {
    const source = env || (typeof process !== 'undefined' ? process.env : {});
    const token = clean(source.TELEGRAM_BOT_TOKEN, 200);
    const chatId = clean(source.TELEGRAM_CHAT_ID, 64);
    if (!token || !chatId) return null;
    return { token, chatId };
}

export function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

// Сповіщаємо лише про щойно створений акаунт і лише один раз (позначка в app_metadata, яку юзер не змінить).
export function shouldNotifySignup(user, now = Date.now()) {
    if (!user || !user.id) return false;
    if (user.app_metadata && user.app_metadata.signup_notified_at) return false;
    const created = Date.parse(user.created_at);
    if (!Number.isFinite(created)) return false;
    return now - created >= -60 * 1000 && now - created <= SIGNUP_NOTIFY_WINDOW_MS;
}

export function signupMessage(user, org) {
    const meta = (user && user.user_metadata) || {};
    const company = clean(meta.company_name || (org && org.name), 100) || '—';
    const workMode = meta.work_mode || (org && org.work_mode) || '';
    const ownership = meta.ownership || '';
    return [
        '🆕 Нова реєстрація в TRIP-CONTROL',
        'Email: ' + (clean(user && user.email, 160) || '—'),
        'Компанія: ' + company,
        'Режим роботи: ' + (WORK_MODE_LABEL[workMode] || '—'),
        'Форма: ' + (OWNERSHIP_LABEL[ownership] || '—')
    ].join('\n');
}

// Кнопки статусу під повідомленням про юзера. callback_data: st:<status>:<user_id> (≤ 64 байти).
export const STATUS_BUTTONS = [
    ['full', '✅ Повний доступ'],
    ['demo', '🧪 Демо'],
    ['blocked', '⛔ Заблокувати']
];

export function statusKeyboard(userId) {
    return {
        inline_keyboard: [STATUS_BUTTONS.map(([status, text]) => ({ text, callback_data: 'st:' + status + ':' + userId }))]
    };
}

// Виклик методу Bot API. Помилка не містить токена (лише назву методу і HTTP-статус).
export async function telegramApi(method, payload, options = {}) {
    const config = telegramConfig(options.env);
    if (!config) {
        const error = new Error('Telegram не налаштовано.');
        error.code = 'TELEGRAM_UNCONFIGURED';
        throw error;
    }
    if (typeof options.fetch !== 'function') throw new Error('fetch недоступний.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 5000) : null;
    try {
        const response = await options.fetch('https://api.telegram.org/bot' + config.token + '/' + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
            signal: controller ? controller.signal : undefined
        });
        if (!response.ok) {
            const error = new Error('Telegram не прийняв ' + method + '.');
            error.code = 'TELEGRAM_FAILED';
            error.status = response.status;
            throw error;
        }
        return true;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function sendTelegram(text, options = {}) {
    const config = telegramConfig(options.env);
    const payload = { chat_id: config ? config.chatId : '', text: String(text || ''), disable_web_page_preview: true };
    if (options.replyMarkup) payload.reply_markup = options.replyMarkup;
    return telegramApi('sendMessage', payload, options);
}
