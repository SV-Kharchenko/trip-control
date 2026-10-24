// Склад: залишки з середньою собівартістю й вартістю залишку, пошук, «Прихід», «Нова запчастина», імпорт і шаблон CSV,
// історія руху, «Коригування» (власник / директор).
import { h, clear, spinner, notice, toast, download } from '../ui.js';
import { fmtMoney, fmtMoneyCents, fmtNumber, fmtDate, kyivDate } from '../lib/format.js';
import { repairErrorText, stockValue } from '../lib/repairs.js';
import { importTemplateCsv } from '../lib/csv.js';
import { renderImport } from './repairs-import.js';

const HISTORY_KIND = { receipt: 'Прихід', opening: 'Початковий залишок', writeoff: 'Списання на ремонт', adjustment: 'Коригування' };

function field(id, label, input) {
    return h('div', { class: 'field' }, h('label', { for: id }, label), input);
}

export function filterParts(parts, query) {
    const q = String(query || '').trim().toLowerCase();
    return (parts || []).filter((p) => !q || (p.name + ' ' + (p.article || '')).toLowerCase().includes(q));
}

export function renderStock(app, access) {
    const state = { parts: [] };
    const search = h('input', { type: 'search', class: 'grow', placeholder: 'Пошук: назва або артикул', 'aria-label': 'Пошук запчастин' });
    const list = h('div', { class: 'list' }, spinner());
    const panel = h('div', { class: 'kpr-panel' });
    const message = h('div', { 'aria-live': 'polite' });

    const fail = (error) => clear(message, notice(repairErrorText(error)));
    const done = async (text) => {
        clear(panel);
        clear(message);
        toast(text);
        await load();
    };

    function partSelect(id, selected) {
        return h('select', { id }, h('option', { value: '' }, '— запчастина —'),
            state.parts.filter((p) => !p.archived_at).map((p) => h('option', { value: p.id, selected: p.id === selected }, p.name + (p.article ? ' (' + p.article + ')' : ''))));
    }

    function newPartForm() {
        const name = h('input', { id: 'kpr-p-name', maxlength: '200' });
        const article = h('input', { id: 'kpr-p-article', maxlength: '64' });
        const unit = h('input', { id: 'kpr-p-unit', maxlength: '16', value: 'шт' });
        clear(panel, h('form', { class: 'card', onsubmit: async (e) => {
            e.preventDefault();
            const { error } = await app.supabase.rpc('kp_part_upsert', { p_id: null, p_name: name.value, p_article: article.value, p_unit: unit.value,
                p_min_qty: null, p_notes: null, p_archived: false });
            if (error) fail(error); else done('Запчастину додано');
        } }, h('h3', null, 'Нова запчастина'),
        h('div', { class: 'form' }, field('kpr-p-name', 'Назва', name), field('kpr-p-article', 'Артикул', article), field('kpr-p-unit', 'Одиниця', unit),
            h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => clear(panel) }, 'Скасувати')))));
    }

    function receiptForm(partId) {
        const part = partSelect('kpr-r-part', partId);
        const qty = h('input', { id: 'kpr-r-qty', type: 'number', inputmode: 'decimal', min: '0', step: '0.001' });
        const price = h('input', { id: 'kpr-r-price', type: 'number', inputmode: 'decimal', min: '0', step: '0.01' });
        const date = h('input', { id: 'kpr-r-date', type: 'date', value: kyivDate(), max: kyivDate() });
        const supplier = h('input', { id: 'kpr-r-supplier', maxlength: '200' });
        const doc = h('input', { id: 'kpr-r-doc', maxlength: '64' });
        const opening = h('input', { id: 'kpr-r-opening', type: 'checkbox' });
        clear(panel, h('form', { class: 'card', onsubmit: async (e) => {
            e.preventDefault();
            if (!part.value || !(Number(qty.value) > 0) || !(Number(price.value) >= 0) || price.value === '') {
                clear(message, notice('Оберіть запчастину, кількість більше 0 і ціну від 0.'));
                return;
            }
            const { error } = await app.supabase.rpc('kp_part_receive', { p_part: part.value, p_qty: Number(qty.value), p_unit_price: Number(price.value),
                p_date: date.value, p_supplier: supplier.value || null, p_doc: doc.value || null, p_note: null, p_kind: opening.checked ? 'opening' : 'receipt' });
            if (error) fail(error); else done('Прихід збережено');
        } }, h('h3', null, 'Прихід'),
        h('div', { class: 'form' }, field('kpr-r-part', 'Запчастина', part), field('kpr-r-qty', 'Кількість', qty), field('kpr-r-price', 'Ціна за одиницю, ₴', price),
            field('kpr-r-date', 'Дата', date), field('kpr-r-supplier', 'Постачальник', supplier), field('kpr-r-doc', 'Документ (№ накладної)', doc),
            h('div', { class: 'field field-check' }, h('label', { for: 'kpr-r-opening' }, opening, ' Початковий залишок')),
            h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти прихід'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => clear(panel) }, 'Скасувати')))));
    }

    function adjustForm(p) {
        const delta = h('input', { id: 'kpr-a-qty', type: 'number', inputmode: 'decimal', step: '0.001', placeholder: '+2 або -1' });
        const cost = h('input', { id: 'kpr-a-cost', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: fmtMoneyCents(p.avg_cost) });
        const reason = h('input', { id: 'kpr-a-reason', maxlength: '500', placeholder: 'Інвентаризація, брак…' });
        clear(panel, h('form', { class: 'card', onsubmit: async (e) => {
            e.preventDefault();
            const { error } = await app.supabase.rpc('kp_stock_adjust', { p_part: p.id, p_qty_delta: Number(delta.value),
                p_unit_cost: cost.value === '' ? null : Number(cost.value), p_reason: reason.value });
            if (error) fail(error); else done('Коригування збережено');
        } }, h('h3', null, 'Коригування: ' + p.name),
        h('p', { class: 'muted small' }, 'Залишок ' + fmtNumber(p.qty) + ' ' + p.unit + '. Плюс — за вказаною ціною (порожньо — поточна середня), мінус — за середньою.'),
        h('div', { class: 'form' }, field('kpr-a-qty', 'Зміна кількості', delta), field('kpr-a-cost', 'Ціна за одиницю (для +), ₴', cost),
            field('kpr-a-reason', 'Причина', reason),
            h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => clear(panel) }, 'Скасувати')))));
    }

    async function history(p) {
        clear(panel, spinner());
        const { data, error } = await app.supabase.rpc('kp_part_history', { p_part: p.id });
        if (error) return fail(error);
        clear(panel, h('div', { class: 'card' }, h('div', { class: 'page-head' }, h('h3', null, 'Рух: ' + p.name),
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => clear(panel) }, 'Закрити')),
        (data || []).length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Дата', 'Рух', 'Кількість', 'Ціна / собівартість', 'Сума', 'Деталі'].map((t) => h('th', null, t)))),
            h('tbody', null, data.map((m) => h('tr', { class: m.reversed ? 'is-archived' : '' },
                h('td', { 'data-label': 'Дата' }, fmtDate(m.on_date)),
                h('td', { 'data-label': 'Рух' }, HISTORY_KIND[m.kind] || m.kind, m.reversed ? h('span', { class: 'tag' }, 'сторно') : null),
                h('td', { 'data-label': 'Кількість', class: 'mono ' + (Number(m.qty) < 0 ? 'neg' : 'pos') }, (Number(m.qty) > 0 ? '+' : '') + fmtNumber(m.qty)),
                h('td', { 'data-label': 'Ціна', class: 'mono' }, fmtMoneyCents(m.unit_cost)),
                h('td', { 'data-label': 'Сума', class: 'mono' }, fmtMoney(m.total)),
                h('td', { 'data-label': 'Деталі' }, m.ref || '—')))))) : h('p', { class: 'muted' }, 'Руху ще не було.')));
    }

    function draw() {
        const rows = filterParts(state.parts, search.value);
        if (!state.parts.length) {
            clear(list, h('div', { class: 'empty' }, h('p', null, 'Склад порожній. Додайте запчастини або імпортуйте початкові залишки з CSV.')));
            return;
        }
        const total = state.parts.reduce((s, p) => s + stockValue(p), 0);
        clear(list,
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Запчастина', 'Артикул', 'Залишок', 'Середня собівартість', 'Вартість залишку', ''].map((t) => h('th', null, t)))),
                h('tbody', null, rows.map((p) => h('tr', { class: p.archived_at ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Запчастина' }, p.name),
                    h('td', { 'data-label': 'Артикул', class: 'mono' }, p.article || '—'),
                    h('td', { 'data-label': 'Залишок', class: 'mono' + (Number(p.qty) === 0 ? ' muted' : '') }, fmtNumber(p.qty) + ' ' + p.unit),
                    h('td', { 'data-label': 'Собівартість', class: 'mono' }, fmtMoneyCents(p.avg_cost)),
                    h('td', { 'data-label': 'Вартість', class: 'mono' }, fmtMoney(stockValue(p))),
                    h('td', { 'data-label': '' }, h('div', { class: 'actions' },
                        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => history(p) }, 'Історія'),
                        access.canWrite ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => receiptForm(p.id) }, 'Прихід') : null,
                        access.canManage ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => adjustForm(p) }, 'Коригування') : null))))))),
            h('p', { class: 'muted small' }, 'Вартість складу: ', h('b', null, fmtMoney(total)), ' · позицій: ' + state.parts.length));
    }

    async function load() {
        const { data, error } = await app.supabase.from('parts').select('id, name, article, unit, qty, avg_cost, archived_at').order('name', { ascending: true }).limit(5000);
        if (error) {
            clear(list, notice(repairErrorText(error)));
            return;
        }
        state.parts = data || [];
        draw();
    }

    search.addEventListener('input', draw);
    load();
    return h('div', null,
        h('div', { class: 'toolbar' }, search,
            access.canWrite ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => receiptForm('') }, 'Прихід') : null,
            access.canWrite ? h('button', { type: 'button', class: 'btn', onclick: newPartForm }, 'Нова запчастина') : null,
            access.canWrite ? h('button', { type: 'button', class: 'btn', onclick: () => clear(panel, renderImport(app, { onDone: () => done('Імпорт завершено') })) }, 'Імпорт CSV') : null,
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => download('shablon_zalyshky.csv', importTemplateCsv()) }, 'Шаблон CSV')),
        message, panel, list);
}
