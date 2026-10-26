// Картка документа: реквізити сторін, рядки, суми, PDF; для рахунку — оплати (у валюті документа, без курсових
// різниць): «Оплачено повністю» однією кнопкою, часткова — сума й дата, анулювання помилкової. Анулює документ owner.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { amountInWords } from '../lib/amount-words.js';
import {
    DOC_TITLES, docErrorText, docNumberText, fmtAmount, fmtMoneyPlain, fmtQty,
} from '../lib/docs.js';
import { partyLines, rateLine } from '../lib/pdf-docs-text.js';
import { showError, statusBadge, pdfButton, cancelControl } from './docs.js';

export function renderDocCard(app, access, id) {
    const box = h('div', null, spinner());

    async function load() {
        const { data, error } = await app.supabase.rpc('kp_doc_get', { p_doc: id });
        if (error) return showError(app, box, error);
        draw(data);
    }

    function party(title, p) {
        return h('div', { class: 'card' }, h('h3', { class: 'kpd-party-title' }, title),
            partyLines(p, { contract: title === 'Покупець' || title === 'Замовник' }).map((line, i) => h('p', { class: i ? 'small' : 'kpd-party-name' }, line)),
            p && (p.signer_position || p.signer_name) ? h('p', { class: 'small muted' }, 'Підписант: ' + [p.signer_position, p.signer_name].filter(Boolean).join(' ')) : null);
    }

    function draw(doc) {
        const cur = doc.currency;
        const vat = Number(doc.vat_rate) === 20;
        const isInvoice = doc.kind === 'invoice';
        const active = doc.status === 'issued';
        clear(box,
            h('a', { class: 'back', href: '#/docs' }, '← До документів'),
            h('div', { class: 'page-head' },
                h('div', null,
                    h('h2', null, (DOC_TITLES[doc.kind] || doc.kind) + ' № ' + docNumberText(doc) + ' від ' + fmtDate(doc.doc_date), ' ', statusBadge(doc.pay_status)),
                    h('p', { class: 'muted' }, 'Клієнт: ', h('a', { href: '#/clients/' + doc.client_id }, doc.client_name || '—'),
                        doc.created_by_email ? ' · створив(ла) ' + doc.created_by_email : '',
                        doc.parent ? [' · до рахунку ', h('a', { href: '#/docs/' + doc.parent.id }, '№ ' + doc.parent.number_text)] : null)),
                h('div', { class: 'actions' },
                    pdfButton(app, doc.id, 'Завантажити PDF', 'btn btn-primary'),
                    isInvoice && active && access.canWrite ? h('a', { class: 'btn', href: '#/docs/new/act/' + doc.client_id }, 'Створити акт') : null)),
            doc.status === 'cancelled' ? notice('Анульовано ' + fmtDate(doc.cancelled_at) + (doc.cancelled_by_email ? ' (' + doc.cancelled_by_email + ')' : '')
                + ': ' + (doc.cancelled_reason || '—') + '. Номер не використовується повторно.', 'error') : null,
            h('div', { class: 'grid-2 kpd-parties' }, party(isInvoice ? 'Постачальник' : 'Виконавець', doc.seller), party(isInvoice ? 'Покупець' : 'Замовник', doc.buyer)),
            h('div', { class: 'table-wrap kpr-cards kpd-doc-lines' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['№', 'Найменування', 'Од.', 'К-сть', 'Ціна', 'Сума'].map((t) => h('th', null, t)))),
                h('tbody', null, (doc.lines || []).map((l) => h('tr', null,
                    h('td', { 'data-label': '№' }, String(l.sort)),
                    h('td', { 'data-label': 'Найменування', class: 'kpr-works' }, l.title),
                    h('td', { 'data-label': 'Од.' }, l.unit),
                    h('td', { 'data-label': 'К-сть', class: 'mono' }, fmtQty(l.qty)),
                    h('td', { 'data-label': 'Ціна', class: 'mono' }, fmtMoneyPlain(l.price)),
                    h('td', { 'data-label': 'Сума', class: 'mono' }, fmtMoneyPlain(l.amount))))))),
            h('div', { class: 'kpr-totals kpd-totals' },
                h('span', null, vat ? 'Без ПДВ: ' : 'Разом: ', h('b', null, fmtAmount(doc.subtotal, cur))),
                vat ? h('span', null, 'ПДВ 20 % (' + (doc.vat_mode === 'gross' ? 'у ціні' : 'зверху') + '): ', h('b', null, fmtAmount(doc.vat_amount, cur))) : h('span', { class: 'muted' }, 'Без ПДВ'),
                h('span', null, 'Всього: ', h('b', null, fmtAmount(doc.total, cur)))),
            h('p', null, h('b', null, 'Сума прописом: '), amountInWords(doc.total, cur)),
            cur !== 'UAH' ? h('p', { class: 'small' }, rateLine(doc)) : null,
            isInvoice && doc.due_date ? h('p', { class: 'small' }, 'Оплатити до: ', h('b', null, fmtDate(doc.due_date))) : null,
            (doc.children || []).length ? h('p', { class: 'small' }, 'Акти до рахунку: ', doc.children.map((c, i) => [i ? ', ' : '',
                h('a', { href: '#/docs/' + c.id }, '№ ' + c.number_text), c.status === 'cancelled' ? ' (анульовано)' : ''])) : null,
            isInvoice ? payments(doc) : null,
            access.isOwner && active ? h('div', { class: 'card kpd-danger' }, h('h3', null, 'Анулювання'),
                h('p', { class: 'small muted' }, 'Документ не видаляється: він лишається в списку з позначкою «Анульовано», номер не повторюється. '
                    + (isInvoice ? 'Рахунок з оплатами — спершу анулюйте оплати.' : 'Рейси акта можна буде виставити знову.')),
                cancelControl(app, doc, load)) : null);
    }

    function payments(doc) {
        const cur = doc.currency;
        const list = (doc.payments || []);
        const canPay = access.canWrite && doc.status === 'issued' && Number(doc.debt) > 0;
        const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Сума, ' + cur, 'aria-label': 'Сума оплати' });
        const paidOn = h('input', { type: 'date', value: kyivDate(), max: kyivDate(), 'aria-label': 'Дата оплати' });
        const note = h('input', { type: 'text', maxlength: 500, placeholder: 'Коментар (необовʼязково)', 'aria-label': 'Коментар до оплати', class: 'grow' });
        const add = async (sum, date, text) => {
            const { error } = await app.supabase.rpc('kp_payment_add', { p_doc: doc.id, p_paid_on: date, p_amount: sum, p_note: text || null });
            if (error) return toast(docErrorText(error), 'error');
            toast('Оплату відмічено');
            load();
        };
        return h('div', { class: 'card kpd-payments' },
            h('h3', null, 'Оплати'),
            h('div', { class: 'kpr-totals' },
                h('span', null, 'Сума: ', h('b', null, fmtAmount(doc.total, cur))),
                h('span', null, 'Оплачено: ', h('b', null, fmtAmount(doc.paid, cur))),
                h('span', null, 'Борг: ', h('b', { class: Number(doc.debt) > 0 ? 'neg' : 'pos' }, doc.debt === null || doc.debt === undefined ? '—' : fmtAmount(doc.debt, cur)))),
            list.length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Дата', 'Сума', 'Коментар', 'Статус', ''].map((t) => h('th', null, t)))),
                h('tbody', null, list.map((p) => h('tr', { class: p.voided_at ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Дата' }, fmtDate(p.paid_on)),
                    h('td', { 'data-label': 'Сума', class: 'mono' }, fmtAmount(p.amount, cur)),
                    h('td', { 'data-label': 'Коментар' }, p.note || '—'),
                    h('td', { 'data-label': 'Статус' }, p.voided_at ? 'анульовано ' + fmtDate(p.voided_at) : 'зараховано'),
                    h('td', { 'data-label': '' }, access.canWrite && !p.voided_at ? confirmButton('Анулювати', 'Точно?', async () => {
                        const { error } = await app.supabase.rpc('kp_payment_void', { p_payment: p.id });
                        if (error) return toast(docErrorText(error), 'error');
                        toast('Оплату анульовано, борг повернуто');
                        load();
                    }, 'btn btn-sm btn-danger') : null)))))) : h('p', { class: 'muted' }, 'Оплат ще немає.'),
            canPay ? h('div', { class: 'kpd-pay-form' },
                h('button', { type: 'button', class: 'btn btn-primary', onclick: () => add(Number(doc.debt), kyivDate(), null) },
                    'Оплачено повністю (' + fmtAmount(doc.debt, cur) + ')'),
                h('div', { class: 'toolbar' }, amount, paidOn, note,
                    h('button', {
                        type: 'button', class: 'btn',
                        onclick: () => {
                            const sum = Number(amount.value.replace(/\s+/g, '').replace(',', '.'));
                            if (!(sum > 0)) return toast('Вкажіть суму оплати', 'error');
                            if (sum > Number(doc.debt)) return toast('Оплата більша за борг (' + fmtAmount(doc.debt, cur) + ')', 'error');
                            if (!paidOn.value || paidOn.value > kyivDate()) return toast('Дата оплати — не в майбутньому', 'error');
                            add(sum, paidOn.value, note.value.trim());
                        },
                    }, 'Додати часткову оплату')),
                h('p', { class: 'hint' }, 'Оплати — у валюті документа (' + cur + '), без курсових різниць.')) : null);
    }

    load();
    return box;
}

