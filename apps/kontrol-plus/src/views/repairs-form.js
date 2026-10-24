// Новий ремонт: авто, дата (сьогодні за Києвом), одометр, роботи, СТО, рядки запчастин (пошук, видно залишок).
// Підсумок «Запчастини / СТО / Разом» — за поточною середньою собівартістю, як спише сервер (усе або нічого).
import { h, clear, notice, toast } from '../ui.js';
import { fmtMoney, fmtMoneyCents, fmtNumber, kyivDate } from '../lib/format.js';
import { repairTotals, validateRepairForm, repairPartsPayload, repairErrorText } from '../lib/repairs.js';

export function partOptionLabel(part) {
    return part.name + (part.article ? ' (' + part.article + ')' : '') + ' — залишок ' + fmtNumber(part.qty) + ' ' + (part.unit || '');
}

// «Виконане ТО» (етап 3b): активні типи — лише коли обрано авто.
export function maintenanceChoices(types, vehicleId) {
    return vehicleId ? (types || []).filter((t) => t.is_active) : [];
}

// Обрані типи для kp_repair_set_maintenance: лише ті, що ще є серед варіантів.
export function maintenancePayload(checked, choices) {
    const ids = new Set((choices || []).map((t) => t.id));
    return [...new Set(checked || [])].filter((id) => ids.has(id));
}

export function renderRepairForm(app) {
    const state = { parts: [], partsById: new Map(), lines: [], types: [], checked: new Set() };
    const maintenanceBox = h('div', { class: 'field kpr-wide', hidden: true });
    const vehicle = h('select', { id: 'kpr-vehicle', required: true }, h('option', { value: '' }, '— оберіть авто —'));
    const date = h('input', { id: 'kpr-date', type: 'date', value: kyivDate(), max: kyivDate() });
    const odometer = h('input', { id: 'kpr-odometer', type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: 'км' });
    const works = h('textarea', { id: 'kpr-works', rows: '3', maxlength: '2000', placeholder: 'Що зроблено' });
    const provider = h('input', { id: 'kpr-provider', type: 'text', maxlength: '200', placeholder: 'Назва СТО (якщо ремонт на стороні)' });
    const service = h('input', { id: 'kpr-service', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0' });
    const linesBox = h('div', { class: 'kpr-lines' });
    const totals = h('div', { class: 'kpr-totals', 'aria-live': 'polite' });
    const message = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Зберегти ремонт');

    function drawTotals() {
        const t = repairTotals(state.lines, state.partsById, service.value);
        clear(totals,
            h('span', null, 'Запчастини: ', h('b', null, fmtMoney(t.parts))),
            h('span', null, 'СТО: ', h('b', null, fmtMoney(t.service))),
            h('span', null, 'Разом: ', h('b', null, fmtMoney(t.total))));
    }

    function lineRow(line, index) {
        const search = h('input', { type: 'search', placeholder: 'Пошук запчастини', 'aria-label': 'Пошук запчастини, рядок ' + (index + 1) });
        const select = h('select', { 'aria-label': 'Запчастина, рядок ' + (index + 1) });
        const qty = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.001', value: line.qty, 'aria-label': 'Кількість, рядок ' + (index + 1) });
        const info = h('span', { class: 'hint' });
        function fill() {
            const q = search.value.trim().toLowerCase();
            const options = state.parts.filter((p) => !p.archived_at && (Number(p.qty) > 0 || p.id === line.part_id))
                .filter((p) => !q || (p.name + ' ' + (p.article || '')).toLowerCase().includes(q)).slice(0, 200);
            clear(select, h('option', { value: '' }, '— запчастина —'),
                options.map((p) => h('option', { value: p.id, selected: p.id === line.part_id }, partOptionLabel(p))));
        }
        function sync() {
            const part = state.partsById.get(line.part_id);
            const need = Number(line.qty);
            info.className = 'hint' + (part && need > Number(part.qty) ? ' hint-error' : '');
            info.textContent = part ? 'Залишок ' + fmtNumber(part.qty) + ' ' + (part.unit || '') + ' · ' + fmtMoneyCents(part.avg_cost) + ' за од.'
                + (need > Number(part.qty) ? ' — не вистачає' : '') : '';
            drawTotals();
        }
        search.addEventListener('input', fill);
        select.addEventListener('change', () => { line.part_id = select.value; sync(); });
        qty.addEventListener('input', () => { line.qty = qty.value; sync(); });
        fill();
        sync();
        return h('div', { class: 'kpr-line' }, search, select, qty,
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': 'Прибрати рядок ' + (index + 1), onclick: () => {
                state.lines.splice(index, 1);
                drawLines();
            } }, '×'), info);
    }

    function drawMaintenance() {
        const choices = maintenanceChoices(state.types, vehicle.value);
        maintenanceBox.hidden = !choices.length;
        clear(maintenanceBox, h('span', { class: 'kpr-label', id: 'kpr-to-label' }, 'Виконане ТО'),
            h('div', { class: 'kpr-to', role: 'group', 'aria-labelledby': 'kpr-to-label' }, choices.map((t) => h('label', { class: 'check' },
                h('input', { type: 'checkbox', value: t.id, checked: state.checked.has(t.id),
                    onchange: (e) => { if (e.target.checked) state.checked.add(t.id); else state.checked.delete(t.id); } }),
                ' ' + t.name))),
            h('p', { class: 'hint' }, 'Відлік цих ТО почнеться з дати й одометра ремонту (без одометра — з розрахункового пробігу).'));
    }

    function drawLines() {
        clear(linesBox, state.lines.map(lineRow),
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { state.lines.push({ part_id: '', qty: '1' }); drawLines(); } }, '+ Запчастина зі складу'));
        drawTotals();
    }

    async function load() {
        const [vehicles, parts] = await Promise.all([
            app.supabase.rpc('kp_repair_vehicles'),
            app.supabase.from('parts').select('id, name, article, unit, qty, avg_cost, archived_at').order('name', { ascending: true }).limit(5000),
        ]);
        if (vehicles.error || parts.error) {
            clear(message, notice(repairErrorText(vehicles.error || parts.error)));
            return;
        }
        for (const v of vehicles.data || []) vehicle.append(h('option', { value: v.id }, v.label));
        state.parts = parts.data || [];
        state.partsById = new Map(state.parts.map((p) => [p.id, p]));
        drawLines();
        // Без міграції 3b (або без типів ТО) блок «Виконане ТО» просто не показується.
        const types = await app.supabase.from('maintenance_types').select('id, name, is_active, sort').eq('is_active', true)
            .order('sort', { ascending: true }).limit(200).then((r) => r, () => ({ data: null }));
        state.types = types && !types.error ? types.data || [] : [];
        drawMaintenance();
    }

    const form = h('form', { class: 'card kpr-form', novalidate: true, onsubmit: async (event) => {
        event.preventDefault();
        const values = { vehicle_id: vehicle.value, date: date.value, odometer: odometer.value, works: works.value, provider: provider.value,
            service_cost: service.value, lines: state.lines };
        const errors = validateRepairForm(values, state.partsById, kyivDate());
        if (errors.length) {
            clear(message, h('div', { class: 'notice notice-error', role: 'alert' }, h('ul', { class: 'kpr-errors' }, errors.map((e) => h('li', null, e.text)))));
            return;
        }
        save.disabled = true;
        clear(message);
        const { data: repairId, error } = await app.supabase.rpc('kp_repair_post', {
            p_vehicle: vehicle.value,
            p_date: date.value,
            p_odometer: odometer.value === '' ? null : Number(odometer.value),
            p_works: works.value.trim(),
            p_provider: provider.value.trim() || null,
            p_service_cost: service.value === '' ? 0 : Number(service.value),
            p_parts: repairPartsPayload(state.lines),
        });
        if (error) {
            save.disabled = false;
            clear(message, notice(repairErrorText(error)));
            return;
        }
        const typeIds = maintenancePayload([...state.checked], maintenanceChoices(state.types, vehicle.value));
        if (typeIds.length) {
            const { error: toError } = await app.supabase.rpc('kp_repair_set_maintenance', { p_repair: repairId, p_type_ids: typeIds });
            if (app.refreshMaintenance) app.refreshMaintenance();
            if (toError) {
                // Ремонт уже проведено (склад списано) — не дублюємо його, лише повідомляємо про ТО.
                toast('Ремонт збережено, але ТО не позначено: ' + repairErrorText(toError), 'error');
                app.go('#/repairs');
                return;
            }
        }
        save.disabled = false;
        toast(typeIds.length ? 'Ремонт і виконане ТО збережено' : 'Ремонт збережено');
        app.go('#/repairs');
    } },
    h('h2', null, 'Новий ремонт'),
    h('div', { class: 'form' },
        h('div', { class: 'field' }, h('label', { for: 'kpr-vehicle' }, 'Авто'), vehicle),
        h('div', { class: 'field' }, h('label', { for: 'kpr-date' }, 'Дата'), date),
        h('div', { class: 'field' }, h('label', { for: 'kpr-odometer' }, 'Одометр, км'), odometer),
        h('div', { class: 'field kpr-wide' }, h('label', { for: 'kpr-works' }, 'Роботи'), works),
        h('div', { class: 'field' }, h('label', { for: 'kpr-provider' }, 'СТО'), provider),
        h('div', { class: 'field' }, h('label', { for: 'kpr-service' }, 'Вартість СТО, ₴'), service),
        maintenanceBox,
        h('div', { class: 'field kpr-wide' }, h('span', { class: 'kpr-label' }, 'Запчастини зі складу'), linesBox)),
    totals,
    message,
    h('div', { class: 'actions kpr-sticky' }, save, h('a', { class: 'btn btn-ghost', href: '#/repairs' }, 'Скасувати')));
    service.addEventListener('input', drawTotals);
    vehicle.addEventListener('change', drawMaintenance);
    load();
    return form;
}
