// «Надіслати на пошту»: невелика форма (кому, тема, текст, галочки PDF документів) і журнал відправок документа.
// Лист відправляє сервер (/api/docs/send, Resend): тут лише форма. Ключів у браузері немає. Без налаштованої пошти кнопка
// відправки вимкнена з підписом «Пошта не налаштована».
import { h, clear, notice, toast } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { callKpApi } from '../lib/gps-client.js';
import { DOC_TITLES, docNumberText } from '../lib/docs.js';

export const EMAIL_RE = /^[^@\s,;<>()"]+@[^@\s,;<>()"]+\.[^@\s,;<>()"]+$/;
export const MAX_DOCS = 5;

export function docLabel(doc) {
    return (DOC_TITLES[doc.kind] || doc.kind) + ' № ' + (doc.number_text || docNumberText(doc)) + ' від ' + fmtDate(doc.doc_date);
}

export function defaultSubject(docs, orgName) {
    const first = docs[0];
    const what = docs.length === 1 ? docLabel(first) : 'Документи (' + docs.length + ')';
    return what + (orgName ? ' — ' + orgName : '');
}

export function defaultText(docs, clientName) {
    const list = docs.map((d) => '— ' + docLabel(d)).join('\n');
    return 'Добрий день' + (clientName ? ', ' + clientName : '') + '!\n\nУ вкладенні:\n' + list + '\n\nЗ повагою.';
}

export async function emailConfigured(app) {
    const out = await callKpApi(app, '/api/docs/send', null, 'GET');
    return out.ok ? out.configured === true : null;
}

const STATUS_TEXT = { sent: 'надіслано', failed: 'помилка', queued: 'у черзі' };

// Журнал відправок документа (kp_doc_email_log). Порожній — нічого не малюємо.
export async function renderEmailLog(app, docId) {
    const { data, error } = await app.supabase.rpc('kp_doc_email_log', { p_doc: docId });
    if (error || !Array.isArray(data) || !data.length) return null;
    return h('div', { class: 'card kpd-email-log' }, h('h3', null, 'Надсилання на пошту'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Коли', 'Кому', 'Хто', 'Статус'].map((t) => h('th', null, t)))),
            h('tbody', null, data.map((r) => h('tr', null,
                h('td', null, new Date(r.created_at).toLocaleString('uk-UA')),
                h('td', null, r.to_email),
                h('td', null, r.sender_email || '—'),
                h('td', null, (STATUS_TEXT[r.status] || r.status) + (r.error ? ': ' + r.error : ''))))))));
}

// docs — [{ id, kind, number_text, doc_date, checked }]. Повертає { button, panel }: кнопка показує/ховає форму.
// contract — { id, label, files: ['договір.pdf', …] }: лист із договором (замість рахунків / актів), вкладення визначає сервер.
export function emailControl(app, { docs = [], contract = null, to = '', clientName = '', orgName = '', onSent = null, label = 'Надіслати на пошту' }) {
    const panel = h('div', { class: 'card kpd-email', hidden: true });
    let opened = false;
    const button = h('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
            panel.hidden = !panel.hidden;
            if (panel.hidden || opened) return;
            opened = true;
            clear(panel, h('p', { class: 'muted' }, 'Перевіряємо пошту…'));
            const configured = await emailConfigured(app);
            draw(configured);
        },
    }, label);

    function draw(configured) {
        const picks = contract ? [] : docs.map((d) => ({ doc: d, box: h('input', { type: 'checkbox', checked: d.checked !== false, id: 'kpe-doc-' + d.id }) }));
        const selected = () => picks.filter((p) => p.box.checked).map((p) => p.doc);
        // Антиспам: за замовчуванням лише пошта контрагента з картки (поле тільки для читання). Інша адреса — після явного підтвердження.
        const cardEmail = String(to || '').trim();
        const toInput = h('input', { type: 'email', id: 'kpe-to', value: cardEmail, maxlength: 254, autocomplete: 'off', placeholder: 'client@example.com', readonly: Boolean(cardEmail) });
        const otherBox = h('input', { type: 'checkbox', id: 'kpe-other' });
        otherBox.onchange = () => {
            toInput.readOnly = !otherBox.checked;
            if (!otherBox.checked) toInput.value = cardEmail;
            else toInput.focus();
        };
        if (!cardEmail) otherBox.checked = true;
        const subjectDocs = () => (selected().length ? selected() : docs);
        const subject = h('input', { type: 'text', id: 'kpe-subject', maxlength: 200, value: contract ? contract.label + (orgName ? ' — ' + orgName : '') : defaultSubject(subjectDocs(), orgName) });
        const text = h('textarea', { id: 'kpe-text', rows: 5, maxlength: 5000 }, contract ? 'Добрий день' + (clientName ? ', ' + clientName : '') + '!\n\nУ вкладенні: ' + contract.label + '.\n\nЗ повагою.' : defaultText(subjectDocs(), clientName));
        const status = h('div', { 'aria-live': 'polite' });
        const send = h('button', { type: 'button', class: 'btn btn-primary', disabled: configured !== true }, 'Надіслати');
        send.onclick = async () => {
            const chosen = selected();
            if (!contract && !chosen.length) return clear(status, notice('Оберіть хоча б один документ.'));
            if (chosen.length > MAX_DOCS) return clear(status, notice('Не більше ' + MAX_DOCS + ' документів за раз.'));
            if (!EMAIL_RE.test(toInput.value.trim())) return clear(status, notice('Вкажіть коректну пошту одержувача.'));
            if (!subject.value.trim()) return clear(status, notice('Вкажіть тему листа.'));
            send.disabled = true;
            clear(status, h('p', { class: 'muted' }, 'Надсилаємо…'));
            const base = { to: toInput.value.trim(), other_address: toInput.value.trim().toLowerCase() !== cardEmail.toLowerCase(), subject: subject.value, text: text.value };
            const out = await callKpApi(app, '/api/docs/send', contract ? { ...base, contract_id: contract.id } : { ...base, doc_ids: chosen.map((d) => d.id) });
            send.disabled = false;
            if (!out.ok) return clear(status, notice(out.error || 'Не вдалося надіслати лист.'));
            clear(status);
            toast('Лист надіслано: ' + toInput.value.trim());
            panel.hidden = true;
            opened = false;
            if (onSent) onSent();
        };
        const field = (labelText, id, control) => h('div', { class: 'field' }, h('label', { for: id }, labelText), control);
        clear(panel,
            h('h3', null, 'Надіслати на пошту'),
            configured === true ? null : notice(configured === false ? 'Пошта не налаштована.' : 'Не вдалося перевірити пошту. Спробуйте ще раз.', 'info'),
            h('div', { class: 'form kpd-email-form' },
                field('Кому', 'kpe-to', toInput),
                h('div', { class: 'field' }, h('label', { for: 'kpe-other' }, 'Інша адреса'),
                    h('label', { class: 'kpd-email-pick', for: 'kpe-other' }, otherBox, ' Надіслати на іншу адресу? Лист піде не на пошту з картки контрагента.')),
                field('Тема', 'kpe-subject', subject),
                field('Текст', 'kpe-text', text),
                h('div', { class: 'field' }, h('label', null, contract ? 'Вкладення' : 'PDF'),
                    h('div', { class: 'kpd-email-docs' }, contract
                        ? (contract.files || []).map((name) => h('span', { class: 'kpd-email-pick' }, name))
                        : picks.map((p) => h('label', { class: 'kpd-email-pick', for: p.box.id }, p.box, ' ' + docLabel(p.doc))))),
                status,
                h('div', { class: 'actions' }, send, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { panel.hidden = true; } }, 'Скасувати'))));
    }
    return { button, panel };
}
