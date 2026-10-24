// Вкладка «Ремонти» (етап 3a): підвкладки «Ремонти» (список + новий ремонт), «Склад», «Відповідальні».
// Права — з kp_repairs_context(); кнопки без права запису приховані, але база однаково забороняє запис.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtMoney, fmtNumber, fmtDate, kyivDate, monthRange } from '../lib/format.js';
import { repairsAccess, repairErrorText, REPAIR_ROLE_LABELS } from '../lib/repairs.js';
import { renderRepairForm } from './repairs-form.js';
import { renderStock } from './repairs-stock.js';
import { renderHandlers } from './repairs-handlers.js';

export function repairsTabs(access) {
    return [
        { sub: 'list', hash: '#/repairs', label: 'Ремонти' },
        { sub: 'stock', hash: '#/repairs/stock', label: 'Склад' },
        access.canManage ? { sub: 'handlers', hash: '#/repairs/handlers', label: 'Відповідальні' } : null,
    ].filter(Boolean);
}

export function partsSummary(parts) {
    return (parts || []).map((p) => p.name + ' × ' + fmtNumber(p.qty) + (p.unit ? ' ' + p.unit : '')).join(', ');
}

function renderList(app, access) {
    const range = monthRange(kyivDate());
    const from = h('input', { type: 'date', value: range.from, 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', value: range.to, 'aria-label': 'Період по' });
    const vehicle = h('select', { 'aria-label': 'Авто' }, h('option', { value: '' }, 'Усі авто'));
    const list = h('div', { class: 'list' }, spinner());
    const message = h('div', { 'aria-live': 'polite' });

    async function loadVehicles() {
        const { data } = await app.supabase.rpc('kp_repair_vehicles');
        for (const v of data || []) vehicle.append(h('option', { value: v.id }, v.label));
    }

    async function load() {
        clear(list, spinner());
        const { data, error } = await app.supabase.rpc('kp_repairs_list', { p_from: from.value, p_to: to.value, p_vehicle: vehicle.value || null });
        if (error) {
            clear(list, notice(repairErrorText(error)));
            return;
        }
        const rows = data || [];
        if (!rows.length) {
            clear(list, h('div', { class: 'empty' }, h('p', null, 'За цей період ремонтів немає.'),
                access.canWrite ? h('a', { class: 'btn btn-primary', href: '#/repairs/new' }, 'Новий ремонт') : null));
            return;
        }
        const posted = rows.filter((r) => r.status === 'posted');
        const sum = posted.reduce((s, r) => s + Number(r.total || 0), 0);
        clear(list,
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, ['Дата', 'Авто', 'Одометр', 'Роботи', 'СТО', 'Запчастини', 'Разом', ''].map((t) => h('th', null, t)))),
                h('tbody', null, rows.map((r) => h('tr', { class: r.status === 'void' ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Дата' }, fmtDate(r.repair_date), r.status === 'void' ? h('span', { class: 'tag' }, 'сторно') : null),
                    h('td', { 'data-label': 'Авто' }, r.vehicle_label || '—'),
                    h('td', { 'data-label': 'Одометр', class: 'mono' }, r.odometer_km === null ? '—' : fmtNumber(r.odometer_km) + ' км'),
                    h('td', { 'data-label': 'Роботи', class: 'kpr-works' }, r.works),
                    h('td', { 'data-label': 'СТО' }, r.provider ? r.provider + ' · ' + fmtMoney(r.service_cost) : (Number(r.service_cost) ? fmtMoney(r.service_cost) : '—')),
                    h('td', { 'data-label': 'Запчастини' }, r.parts && r.parts.length ? partsSummary(r.parts) + ' · ' + fmtMoney(r.parts_cost) : '—'),
                    h('td', { 'data-label': 'Разом', class: 'mono' }, h('b', null, fmtMoney(r.total))),
                    h('td', { 'data-label': '' }, access.canWrite && r.can_void ? confirmButton('Сторнувати', 'Точно сторнувати?', async () => {
                        const { error: voidError } = await app.supabase.rpc('kp_repair_void', { p_repair: r.id, p_reason: null });
                        if (voidError) clear(message, notice(repairErrorText(voidError)));
                        else {
                            toast('Ремонт сторновано, запчастини повернуто на склад');
                            await load();
                        }
                    }, 'btn btn-sm btn-danger') : null)))))),
            h('p', { class: 'muted small' }, 'Разом за період (без сторнованих): ', h('b', null, fmtMoney(sum)), ' · ремонтів: ' + posted.length));
    }

    for (const el of [from, to, vehicle]) el.addEventListener('change', load);
    loadVehicles().then(load);
    return h('div', null,
        h('div', { class: 'toolbar' }, from, to, vehicle,
            access.canWrite ? h('a', { class: 'btn btn-primary', href: '#/repairs/new' }, '+ Новий ремонт') : null),
        message, list);
}

export function renderRepairs(app, sub) {
    const access = repairsAccess(app.repairs, app.context);
    const current = sub === 'new' ? 'list' : sub || 'list';
    let body;
    if (sub === 'new') body = access.canWrite ? renderRepairForm(app) : notice('Немає права вносити ремонти.', 'info');
    else if (sub === 'stock') body = renderStock(app, access);
    else if (sub === 'handlers') body = access.canManage ? renderHandlers(app, access) : notice('Розділ доступний власнику й директору.', 'info');
    else body = renderList(app, access);
    return h('section', { class: 'page kpr-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Ремонти і склад'),
            // Роль власника / директора вже в шапці Контроль+; тут — лише роль, специфічна для ремонтів.
            access.role === 'repair_manager' ? h('span', { class: 'badge' }, REPAIR_ROLE_LABELS.repair_manager)
                : access.role === 'logist' && access.canWrite ? h('span', { class: 'badge' }, 'Відповідальний за ремонти') : null),
        h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи ремонтів' }, repairsTabs(access).map((t) =>
            h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === current ? ' on' : ''), 'aria-current': t.sub === current ? 'page' : null }, t.label))),
        access.canWrite ? null : notice('Режим перегляду: вносити ремонти й приходи можуть власник, директор і призначені відповідальні.', 'info'),
        body);
}
