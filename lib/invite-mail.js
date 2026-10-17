// Лист-запрошення в команду. Відправляє лише сервер (api/team.js) через Resend.
// Посилання підписане й живе 7 днів; лист однаковий для нового й наявного акаунта.

import { validEmail, validFrom } from './weekly-report.js';

function clean(value, max) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max || 120);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatKyivDate(iso) {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return '';
    return new Intl.DateTimeFormat('uk-UA', {
        timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(at);
}

export const INVITE_MAIL_TIMEOUT_MS = 8000;

// Vercel env: RESEND_API_KEY і INVITE_FROM_EMAIL (або REPORT_FROM_EMAIL, як у тижневого звіту).
export function inviteMailProvider(env) {
    const source = env || (typeof process !== 'undefined' ? process.env : {});
    const apiKey = String(source.RESEND_API_KEY || '').trim();
    const from = String(source.INVITE_FROM_EMAIL || source.REPORT_FROM_EMAIL || '').trim();
    if (!apiKey || !validFrom(from)) return null;
    return { apiKey, from };
}

export function buildInviteEmail({ orgName, inviterEmail, url, expiresAt } = {}) {
    const company = clean(orgName, 100) || 'компанію';
    const inviter = clean(inviterEmail, 160);
    const until = formatKyivDate(expiresAt);
    const link = String(url || '');
    const subject = 'Запрошення в ' + company + ' — TRIP-CONTROL';
    const who = inviter ? inviter + ' запрошує вас' : 'Вас запрошують';
    const text = [
        who + ' приєднатися до компанії «' + company + '» у TRIP-CONTROL як логіст.',
        '',
        'Приєднатися: ' + link,
        until ? 'Посилання дійсне до ' + until + '.' : 'Посилання дійсне 7 днів.',
        '',
        'Якщо ви не чекали цього листа, просто проігноруйте його.'
    ].join('\n');
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0D2A28;max-width:520px">' +
        '<p>' + escapeHtml(who) + ' приєднатися до компанії <b>«' + escapeHtml(company) + '»</b> у TRIP-CONTROL як логіст.</p>' +
        '<p style="margin:24px 0"><a href="' + escapeHtml(link) + '" style="display:inline-block;padding:12px 22px;border-radius:8px;' +
        'background:#0D2A29;color:#F4EFE5;text-decoration:none;font-weight:600">Приєднатися</a></p>' +
        '<p style="color:#5A6B66;font-size:13px">' + escapeHtml(until ? 'Посилання дійсне до ' + until + '.' : 'Посилання дійсне 7 днів.') +
        ' Якщо кнопка не працює, відкрийте:<br><a href="' + escapeHtml(link) + '" style="color:#1A6B65;word-break:break-all">' + escapeHtml(link) + '</a></p>' +
        '<p style="color:#5A6B66;font-size:13px">Якщо ви не чекали цього листа, просто проігноруйте його.</p></div>';
    return { subject, text, html };
}

export async function sendInviteEmail(to, message, options = {}) {
    const provider = inviteMailProvider(options.env);
    if (!provider || typeof options.fetch !== 'function') {
        const error = new Error('Пошта для запрошень не налаштована.');
        error.code = 'INVITE_MAIL_UNCONFIGURED';
        throw error;
    }
    const address = String(to || '').trim();
    if (!validEmail(address) || /[\r\n]/.test(address)) {
        const error = new Error('Некоректна адреса.');
        error.code = 'INVITE_MAIL_BAD_TO';
        throw error;
    }
    // Resend that hangs must not hold the invite request: after 8 s the owner gets the link.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || INVITE_MAIL_TIMEOUT_MS) : null;
    let response;
    try {
        response = await options.fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + provider.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: provider.from,
                to: [address],
                subject: clean(message.subject, 180),
                text: String(message.text || ''),
                html: String(message.html || '')
            }),
            signal: controller ? controller.signal : undefined
        });
    } catch {
        const error = new Error(controller && controller.signal.aborted ? 'Пошта не відповіла вчасно.' : 'Пошта недоступна.');
        error.code = controller && controller.signal.aborted ? 'INVITE_MAIL_TIMEOUT' : 'INVITE_MAIL_FAILED';
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
    if (!response.ok) {
        const error = new Error('Пошта не прийняла лист.');
        error.code = 'INVITE_MAIL_FAILED';
        error.status = response.status;
        throw error;
    }
    return true;
}

export function joinedMessage({ email, orgName }) {
    return [
        '👥 Логіст приєднався до компанії',
        'Email: ' + (clean(email, 160) || '—'),
        'Компанія: ' + (clean(orgName, 100) || '—')
    ].join('\n');
}
