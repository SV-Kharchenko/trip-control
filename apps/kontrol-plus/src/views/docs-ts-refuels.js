// Подорожній лист, зворотний бік: редактор дозаправок в дорозі (таблиця; на телефоні кожен рядок — картка). Сума = літри × ціна
// рахується автоматично й не редагується. Кнопки — за розміром вмісту. Зберігає картка листа (kp_trip_sheet_refuels_save), поки лист «Видано».
import { h, clear } from '../ui.js';
import { PAY_METHODS, REFUEL_LABELS, addRefuel, refuelAmount, removeRefuel, validateRefuels } from '../lib/trip-sheet-refuels.js';

const num = (x) => (x === null || x === undefined ? '—' : String(x).replace('.', ','));

// list — масив рядків форми (emptyRefuel). onChange() викликається після кожної зміни (картка перераховує факт пального).
export function refuelsEditor(list, onChange) {
    const state = { list };
    const box = h('div', { class: 'kpts-refuels' });

    function control(index, field, tag, attrs, label) {
        const el = h(tag, Object.assign({ 'aria-label': label + ', дозаправка ' + (index + 1) }, tag === 'input' ? { type: 'text', autocomplete: 'off' } : {}, attrs));
        if (tag === 'select') {
            el.append(h('option', { value: '' }, '—'), ...Object.entries(PAY_METHODS).map(([value, text]) => h('option', { value }, text)));
        }
        el.value = state.list[index][field] || '';
        const handler = () => {
            state.list[index][field] = el.value;
            const amount = box.querySelector('[data-amount="' + index + '"]');
            if (amount) amount.textContent = num(refuelAmount(state.list[index].liters, state.list[index].price_per_l));
            const errors = validateRefuels(state.list);
            el.toggleAttribute('aria-invalid', Boolean(errors[index] && errors[index][field]));
            onChange();
        };
        el.addEventListener(tag === 'select' ? 'change' : 'input', handler);
        return el;
    }

    function draw() {
        const rows = state.list.map((r, i) => h('tr', null,
            h('td', { 'data-label': '№', class: 'kpts-no' }, String(i + 1)),
            h('td', { 'data-label': REFUEL_LABELS.refuel_at }, control(i, 'refuel_at', 'input', { type: 'datetime-local' }, REFUEL_LABELS.refuel_at)),
            h('td', { 'data-label': REFUEL_LABELS.place }, control(i, 'place', 'input', { maxlength: 300 }, REFUEL_LABELS.place)),
            h('td', { 'data-label': REFUEL_LABELS.liters }, control(i, 'liters', 'input', { inputmode: 'decimal' }, REFUEL_LABELS.liters)),
            h('td', { 'data-label': REFUEL_LABELS.price_per_l }, control(i, 'price_per_l', 'input', { inputmode: 'decimal' }, REFUEL_LABELS.price_per_l)),
            h('td', { 'data-label': REFUEL_LABELS.amount, class: 'mono' }, h('b', { 'data-amount': String(i) }, num(refuelAmount(r.liters, r.price_per_l)))),
            h('td', { 'data-label': REFUEL_LABELS.pay_method }, control(i, 'pay_method', 'select', {}, REFUEL_LABELS.pay_method)),
            h('td', { 'data-label': REFUEL_LABELS.receipt_no }, control(i, 'receipt_no', 'input', { maxlength: 50 }, REFUEL_LABELS.receipt_no)),
            h('td', { 'data-label': '' }, h('button', {
                type: 'button', class: 'btn btn-sm btn-ghost', title: 'Видалити рядок', 'aria-label': 'Видалити дозаправку ' + (i + 1),
                onclick: () => { state.list = removeRefuel(state.list, i); draw(); onChange(); },
            }, 'Видалити'))));
        clear(box,
            state.list.length
                ? h('div', { class: 'table-wrap kpr-cards kpts-table' }, h('table', { class: 'table' },
                    h('thead', null, h('tr', null, ['№', REFUEL_LABELS.refuel_at, REFUEL_LABELS.place, REFUEL_LABELS.liters, REFUEL_LABELS.price_per_l, REFUEL_LABELS.amount,
                        REFUEL_LABELS.pay_method, REFUEL_LABELS.receipt_no, ''].map((t) => h('th', null, t)))),
                    h('tbody', null, rows)))
                : h('p', { class: 'muted' }, 'Дозаправок у дорозі немає. Додайте рядок, якщо авто заправлялось у рейсі: літри потрапляють у факт пального.'),
            h('div', { class: 'actions' }, h('button', {
                type: 'button', class: 'btn', onclick: () => { state.list = addRefuel(state.list); draw(); onChange(); },
            }, 'Додати дозаправку')));
    }

    draw();
    return { node: box, get: () => state.list, set: (next) => { state.list = next; draw(); } };
}
