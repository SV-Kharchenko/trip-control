// «Автопарк»: підвкладки Авто / Причепи, живий фільтр за держномером (підрядок, нормалізація кирилиця → латиниця) і компактна
// таблиця. Дані — kp_vehicles_list (RLS директора обійдено RPC): номер, марка / модель, тип, найближче ТО (service_on).
// Поля для ТТН (тип ТЗ, габарити, тара, водій за замовчуванням) — у згорнутому блоці під таблицею «Авто».
import { h, clear, spinner, notice } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { daysLeft, docState } from '../lib/fleet.js';
import { plateMatches } from '../lib/plates.js';
import { docsAccess } from '../lib/docs.js';
import { renderFleet } from './docs-fleet.js';
import { showError } from './docs.js';

export const FLEET_TABS = [
    { sub: 'cars', hash: '#/fleet', label: 'Авто' },
    { sub: 'trailers', hash: '#/fleet/trailers', label: 'Причепи' },
];

const COLUMNS = ['Номер', 'Марка / модель', 'Тип', 'Стан', 'Пробіг', 'Найближче ТО'];
const dash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));

// Рядок таблиці «Авто» / «Причепи» з запису kp_vehicles_list. Стану й пробігу в цих даних ще немає — «—».
export function vehicleRows(vehicles, sub, today) {
    const rows = [];
    for (const v of vehicles || []) {
        if (sub === 'trailers') {
            if (!v.trailer_plate) continue;
            rows.push({ plate: v.trailer_plate, model: v.trailer_make_model, type: v.trailer_type, state: null, mileage: null, service: null });
        } else {
            rows.push({ plate: v.label, model: v.make_model, type: v.vehicle_type, state: null, mileage: null, service: v.service_on || null, today });
        }
    }
    return rows;
}

function serviceCell(row) {
    if (!row.service) return h('td', { 'data-label': 'Найближче ТО' }, '—');
    const state = docState(row.service, row.today);
    const days = daysLeft(row.service, row.today);
    const text = fmtDate(row.service);
    if (state === 'overdue') return h('td', { 'data-label': 'Найближче ТО' }, text, ' ', h('span', { class: 'kpt-badge is-overdue' }, 'прострочено'));
    if (state === 'soon') return h('td', { 'data-label': 'Найближче ТО' }, text, ' ', h('span', { class: 'kpt-badge is-soon' }, 'за ' + days + ' дн.'));
    return h('td', { 'data-label': 'Найближче ТО' }, text);
}

export function renderFleetPage(app, sub = 'cars') {
    const access = docsAccess(app.context);
    const current = sub === 'trailers' ? 'trailers' : 'cars';
    const today = kyivDate();
    const plate = h('input', { type: 'search', id: 'kpf-plate', placeholder: 'напр. 4821', autocomplete: 'off', 'aria-label': 'Фільтр за держномером' });
    const clearBtn = h('button', { type: 'button', class: 'kpf-clear', 'aria-label': 'Очистити фільтр', hidden: true }, '×');
    const body = h('div', null, spinner());
    let rows = [];

    function draw() {
        const query = plate.value;
        clearBtn.hidden = !query;
        const shown = rows.filter((r) => plateMatches(r.plate, query));
        clear(body, h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table kpf-table' },
            h('thead', null, h('tr', null, COLUMNS.map((t) => h('th', null, t)))),
            h('tbody', null, shown.length
                ? shown.map((r) => h('tr', null,
                    h('td', { 'data-label': 'Номер', class: 'mono' }, dash(r.plate)),
                    h('td', { 'data-label': 'Марка / модель' }, dash(r.model)),
                    h('td', { 'data-label': 'Тип' }, dash(r.type)),
                    h('td', { 'data-label': 'Стан' }, dash(r.state)),
                    h('td', { 'data-label': 'Пробіг', class: 'mono' }, dash(r.mileage)),
                    serviceCell(r)))
                : h('tr', { class: 'kpf-none' }, h('td', { colspan: 6, class: 'muted' },
                    rows.length ? 'Нічого не знайдено' : (current === 'trailers' ? 'Причепів ще немає.' : 'Авто ще немає — власник додає їх у картці авто на сайті.')))))));
    }

    plate.addEventListener('input', draw);
    clearBtn.addEventListener('click', () => { plate.value = ''; draw(); plate.focus(); });

    app.supabase.rpc('kp_vehicles_list').then(({ data, error }) => {
        if (error) return showError(app, body, error);
        rows = vehicleRows(data, current, today);
        draw();
    }, () => clear(body, notice('Не вдалося завантажити автопарк.')));

    const ttn = current === 'cars'
        ? h('details', { class: 'kpf-ttn' }, h('summary', null, 'Поля для ТТН, водій за замовчуванням, строки ТО й страхування'), renderFleet(app, access, 'cars'))
        : null;

    return h('section', { class: 'page kpr-page kpf-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Автопарк')),
        h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи автопарку' }, FLEET_TABS.map((t) =>
            h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === current ? ' on' : ''), 'aria-current': t.sub === current ? 'page' : null }, t.label))),
        h('div', { class: 'kpf-filter' },
            h('label', { for: 'kpf-plate' }, 'Держномер'),
            h('span', { class: 'kpf-field' }, plate, clearBtn)),
        body,
        ttn);
}
