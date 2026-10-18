// Лист-нагадування за 3 дні до кінця оплаченого періоду. Відправка — через Resend
// (deliverReport з lib/weekly-report.js: RESEND_API_KEY + REPORT_FROM_EMAIL, fail closed).
import { deliverReport, mailProvider } from '../weekly-report.js';
import { formatKyivDate } from './access.js';
import { PLANS } from './plans.js';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function reminderMailConfigured(env) {
    return !!mailProvider(env);
}

export function buildReminderEmail({ paidUntil, baseUrl, orgName } = {}) {
    const date = formatKyivDate(paidUntil);
    const payUrl = baseUrl + '/?billing=pay';
    const offerUrl = baseUrl + '/offer';
    const refundUrl = baseUrl + '/payment-refund';
    const subject = 'Trip Control: доступ діє до ' + date;
    const company = String(orgName || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100);
    const lead = 'Повний доступ до Trip Control' + (company ? ' для «' + company + '»' : '') + ' діє до ' + date + '.';
    const prices = 'Продовжити можна на 1 місяць — ' + PLANS.month.uah + ' грн або на 1 рік — ' + PLANS.year.uah + ' грн.';
    const after = 'Після цієї дати компанія перейде в демо-режим; дані збережуться.';
    const text = [
        lead,
        prices,
        after,
        '',
        'Продовжити: ' + payUrl,
        '',
        'Публічна оферта: ' + offerUrl,
        'Оплата та повернення: ' + refundUrl
    ].join('\n');
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0D2A28;max-width:520px">' +
        '<p>' + escapeHtml(lead) + '</p>' +
        '<p>' + escapeHtml(prices) + '</p>' +
        '<p style="color:#5A6B66">' + escapeHtml(after) + '</p>' +
        '<p style="margin:24px 0"><a href="' + escapeHtml(payUrl) + '" style="display:inline-block;padding:12px 22px;border-radius:8px;' +
        'background:#0D2A29;color:#F4EFE5;text-decoration:none;font-weight:600">Продовжити</a></p>' +
        '<p style="color:#5A6B66;font-size:13px"><a href="' + escapeHtml(offerUrl) + '" style="color:#1A6B65">Публічна оферта</a> · ' +
        '<a href="' + escapeHtml(refundUrl) + '" style="color:#1A6B65">Оплата та повернення</a></p></div>';
    return { subject, text, html };
}

export async function sendReminderEmail(to, message, options) {
    return deliverReport(Object.assign({ to }, message), options);
}
