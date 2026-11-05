// «Власний парк → Телематика» (етап 2): звіти Агроконтролю лише для читання — пробіг, пальне, простої, заправки / зливи.
// Власного контролю пального тут немає: показуємо те, що прийшло зі звітів (файл або тестові дані), і підсвічуємо зливи.
// Доступ: owner / director / logist компанії з прапорцем own_fleet. Читання таблиць — через RLS, запис — лише RPC tm_*.
import { h, clear, notice, spinner, toast } from '../../ui.js';
import { loadResources } from './data.js';
import { SOURCE_KINDS, canSyncMock, createAdapter } from '../../lib/telematics/adapter.js';
import { fmtMinutes, fmtNum, isoDaysAgo, summaryRow, telematicsErrorText } from '../../lib/telematics/summary.js';
import { renderTelematicsImport } from './telematics-import.js';

const SYNC_DAYS = 30;
const CHUNK = 4000;
const MODES = [
    { key: 'overview', label: 'Огляд' },
    { key: 'import', label: 'Імпорт' },
    { key: 'mapping', label: 'Зіставлення' },
];

function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

export function renderTelematics(app) {
    const sb = app.supabase;
    const orgId = app.ownFleet && app.ownFleet.org_id;
    const root = h('div', { class: 'kpt' }, spinner());
    const today = isoDaysAgo(0);
    let importNode = null;
    const state = {
        mode: 'overview', from: isoDaysAgo(29), to: today, unit: '', vehicle: '',
        sources: [], templates: [], units: [], vehicles: [], vehicleUnits: [], summary: [], drains: [], unmapped: [], busy: false,
    };

    async function loadBase() {
        const [sources, templates, units, resources, vehicleUnits] = await Promise.all([
            sb.from('telematics_sources').select('id, kind, name, status, last_sync_at').order('created_at', { ascending: true }),
            sb.from('telematics_templates').select('kind, mapping'),
            sb.from('org_units').select('id, name, archived').order('name', { ascending: true }).limit(500),
            loadResources(app),
            sb.from('telematics_vehicle_units').select('vehicle_id, unit_id'),
        ]);
        const error = sources.error || templates.error || units.error || resources.error || vehicleUnits.error;
        if (error) return error;
        state.sources = sources.data || [];
        state.templates = templates.data || [];
        state.units = (units.data || []).filter((u) => !u.archived);
        state.vehicles = resources.vehicles;
        state.vehicleUnits = vehicleUnits.data || [];
        return null;
    }

    async function loadOverview() {
        const args = { p_from: state.from, p_to: state.to, p_unit: state.unit || null, p_vehicle: state.vehicle || null };
        const [summary, drains] = await Promise.all([
            sb.rpc('tm_summary', args),
            sb.from('telematics_fuel_events').select('id, ts, external_vehicle_ref, vehicle_id, liters, location').eq('kind', 'drain')
                .gte('ts', state.from + 'T00:00:00Z').lt('ts', isoDaysAfter(state.to) + 'T00:00:00Z').order('ts', { ascending: false }).limit(100),
        ]);
        const error = summary.error || drains.error;
        if (error) return error;
        state.summary = (summary.data || []).map((r) => summaryRow(r, state.vehicles, state.units));
        state.drains = drains.data || [];
        return null;
    }

    async function loadUnmapped() {
        const [reports, events] = await Promise.all([
            sb.from('telematics_reports').select('external_vehicle_ref, date').is('vehicle_id', null).limit(5000),
            sb.from('telematics_fuel_events').select('external_vehicle_ref, ts').is('vehicle_id', null).limit(5000),
        ]);
        const error = reports.error || events.error;
        if (error) return error;
        const byRef = new Map();
        for (const r of reports.data || []) {
            const e = byRef.get(r.external_vehicle_ref) || { ref: r.external_vehicle_ref, days: new Set(), events: 0 };
            e.days.add(r.date);
            byRef.set(r.external_vehicle_ref, e);
        }
        for (const r of events.data || []) {
            const e = byRef.get(r.external_vehicle_ref) || { ref: r.external_vehicle_ref, days: new Set(), events: 0 };
            e.events += 1;
            byRef.set(r.external_vehicle_ref, e);
        }
        state.unmapped = [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref)).map((e) => ({ ref: e.ref, days: e.days.size, events: e.events }));
        return null;
    }

    function isoDaysAfter(iso) {
        return new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    }

    async function reload() {
        const error = (await loadBase()) || (await Promise.all([loadOverview(), loadUnmapped()]).then((r) => r[0] || r[1]));
        if (error) { clear(root, notice(telematicsErrorText(error))); return; }
        paint();
    }

    async function ensureSource(kind) {
        const { data, error } = await sb.rpc('tm_ensure_source', { p_kind: kind });
        if (error) { toast(telematicsErrorText(error), 'error'); return null; }
        if (!state.sources.some((s) => s.id === data)) await loadBase();
        return data;
    }

    // ---------- Джерела й синхронізація тестових даних ----------
    async function connectMock() {
        state.busy = true;
        paint();
        await ensureSource('agrocontrol_mock');
        state.busy = false;
        await reload();
    }

    async function syncMock(source) {
        if (!canSyncMock(source)) return;
        if (!state.vehicles.length) { toast('Спочатку додайте авто в «Автопарк» — тестові дані створюються для вашої техніки.', 'error'); return; }
        state.busy = true;
        paint();
        try {
            const adapter = createAdapter(source.kind, { orgId, vehicles: state.vehicles.map((v) => ({ id: v.id, label: v.label.split(' · ')[0] })) });
            const range = { from: isoDaysAgo(SYNC_DAYS - 1), to: today };
            const [reports, events] = [await adapter.fetchReports(range), await adapter.fetchFuelEvents(range)];
            let failed = null;
            for (let i = 0; i < reports.length && !failed; i += CHUNK) {
                failed = (await sb.rpc('tm_import_reports', { p_source: source.id, p_rows: reports.slice(i, i + CHUNK) })).error;
            }
            for (let i = 0; i < events.length && !failed; i += CHUNK) {
                failed = (await sb.rpc('tm_import_fuel_events', { p_source: source.id, p_rows: events.slice(i, i + CHUNK) })).error;
            }
            if (failed) toast(telematicsErrorText(failed), 'error');
            else toast('Тестові дані за ' + SYNC_DAYS + ' днів оновлено');
        } catch (e) {
            toast(telematicsErrorText(e), 'error');
        }
        state.busy = false;
        await reload();
    }

    function sourcesBlock() {
        const mock = state.sources.find((s) => s.kind === 'agrocontrol_mock');
        const api = state.sources.find((s) => s.kind === 'agrocontrol_api');
        const rows = state.sources.map((s) => h('li', { class: 'kpt-source', 'data-kind': s.kind },
            h('span', { class: 'kpt-source-name' }, s.name || SOURCE_KINDS[s.kind]),
            h('span', { class: 'muted small' }, s.last_sync_at ? 'оновлено ' + new Date(s.last_sync_at).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) : 'даних ще не було'),
            canSyncMock(s) ? h('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'sync-mock', disabled: state.busy, onclick: () => syncMock(s) }, 'Синхронізувати (тестові дані)') : null));
        return h('div', { class: 'kpt-sources' },
            state.sources.length ? h('ul', { class: 'kpt-source-list' }, rows) : h('p', { class: 'muted' }, 'Джерел даних ще немає. Завантажте файл звіту у вкладці «Імпорт» або підключіть тестові дані.'),
            api ? h('p', { class: 'muted small' }, 'API Агроконтролю ще не підключено.') : null,
            mock ? null : h('button', { type: 'button', class: 'btn', 'data-act': 'connect-mock', disabled: state.busy, onclick: connectMock }, 'Підключити тестові дані (Агроконтроль)'));
    }

    // ---------- Огляд ----------
    function filtersBlock() {
        const change = (key) => async (e) => { state[key] = e.target.value; await refreshOverview(); };
        return h('div', { class: 'kpof-filters kpt-filters' },
            h('input', { type: 'date', 'aria-label': 'Період з', value: state.from, max: state.to, onchange: change('from') }),
            h('input', { type: 'date', 'aria-label': 'Період по', value: state.to, min: state.from, onchange: change('to') }),
            h('select', { 'aria-label': 'Підрозділ', onchange: change('unit') }, h('option', { value: '' }, 'Усі підрозділи'),
                state.units.map((u) => h('option', { value: u.id, selected: u.id === state.unit }, u.name))),
            h('select', { 'aria-label': 'Авто', onchange: change('vehicle') }, h('option', { value: '' }, 'Усі авто'),
                state.vehicles.map((v) => h('option', { value: v.id, selected: v.id === state.vehicle }, v.label))));
    }

    async function refreshOverview() {
        if (!state.from || !state.to || state.from > state.to) { toast('Перевірте період: «з» має бути не пізніше за «по».', 'error'); return; }
        const error = await loadOverview();
        if (error) { toast(telematicsErrorText(error), 'error'); return; }
        paint();
    }

    function overviewBlock() {
        const drainTotal = state.summary.reduce((n, r) => n + r.drainCount, 0);
        const cols = [
            { label: 'Авто', cell: (r) => (r.mapped ? r.label : h('span', null, r.label, ' ', h('span', { class: 'kpof-badge kpof-late', title: 'Не зіставлено з авто автопарку' }, 'не зіставлено'))) },
            { label: 'Підрозділ', cell: (r) => r.unit || '—' },
            { label: 'Пробіг, км', cell: (r) => fmtNum(r.mileage, 1) },
            { label: 'Пальне, л', cell: (r) => fmtNum(r.fuel, 1) },
            { label: 'л/100 км', cell: (r) => fmtNum(r.l100, 1) },
            { label: 'Простій', cell: (r) => fmtMinutes(r.idle) },
            { label: 'Зливи', cell: (r) => (r.drainCount ? h('span', { class: 'kpt-drain', 'data-drain': String(r.drainCount) }, r.drainCount + ' · ' + fmtNum(r.drainL, 1) + ' л') : '0') },
        ];
        return h('div', null,
            filtersBlock(),
            h('div', { class: 'kpof-stats kpt-total' }, h('span', { class: 'kpof-stat on' + (drainTotal ? ' kpof-stat-late' : '') }, h('b', null, String(drainTotal)), ' ' + plural(drainTotal, 'злив', 'зливи', 'зливів') + ' за період')),
            state.summary.length
                ? h('div', { class: 'table-wrap' }, h('table', { class: 'table kpof-table kpt-table', 'aria-label': 'Телематика по авто' },
                    h('thead', null, h('tr', null, cols.map((c) => h('th', null, c.label)))),
                    h('tbody', null, state.summary.map((r) => h('tr', { class: r.drainCount ? 'kpt-row-drain' : '', 'data-ref': r.ref }, cols.map((c) => h('td', { 'data-label': c.label }, c.cell(r))))))))
                : h('p', { class: 'muted' }, 'За цей період даних немає. Завантажте файл звіту або синхронізуйте тестові дані.'),
            state.drains.length ? drainsBlock() : null);
    }

    function drainsBlock() {
        const label = (d) => {
            const v = d.vehicle_id ? state.vehicles.find((x) => x.id === d.vehicle_id) : null;
            return v ? v.label : d.external_vehicle_ref;
        };
        return h('div', { class: 'kpt-drains' },
            h('h3', { class: 'kpof-sub-h' }, 'Зливи за період'),
            h('ul', { class: 'kpt-drain-list' }, state.drains.map((d) => h('li', { class: 'kpt-drain-item' },
                h('b', null, label(d)), ' · ', new Date(d.ts).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }), ' · ', h('span', { class: 'kpt-drain' }, fmtNum(d.liters, 1) + ' л'),
                d.location ? h('span', { class: 'muted' }, ' · ' + d.location) : null))));
    }

    // ---------- Зіставлення ----------
    async function mapRef(ref, vehicleId) {
        if (!vehicleId) { toast('Оберіть авто.', 'error'); return; }
        const { error } = await sb.rpc('tm_set_vehicle_map', { p_ref: ref, p_vehicle: vehicleId });
        if (error) { toast(telematicsErrorText(error), 'error'); return; }
        toast('Зіставлено');
        await reload();
    }

    async function setUnit(vehicleId, unitId) {
        const { error } = await sb.rpc('tm_set_vehicle_unit', { p_vehicle: vehicleId, p_unit: unitId || null });
        if (error) { toast(telematicsErrorText(error), 'error'); return; }
        toast('Збережено');
        const rest = state.vehicleUnits.filter((x) => x.vehicle_id !== vehicleId);
        state.vehicleUnits = unitId ? [...rest, { vehicle_id: vehicleId, unit_id: unitId }] : rest;
        const err = await loadOverview();
        if (err) { toast(telematicsErrorText(err), 'error'); return; }
        paint();
    }

    function mappingBlock() {
        const unmapped = state.unmapped.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'table kpof-table kpt-table', 'aria-label': 'Незмеплені позначки' },
                h('thead', null, h('tr', null, ['Позначка зі звіту', 'У звітах', 'Авто автопарку', ''].map((t) => h('th', null, t)))),
                h('tbody', null, state.unmapped.map((u) => {
                    const sel = h('select', { 'aria-label': 'Авто для ' + u.ref },
                        h('option', { value: '' }, '— оберіть авто —'), state.vehicles.map((v) => h('option', { value: v.id }, v.label)));
                    return h('tr', { 'data-ref': u.ref },
                        h('td', { 'data-label': 'Позначка зі звіту' }, h('b', null, u.ref)),
                        h('td', { 'data-label': 'У звітах' }, u.days + ' ' + plural(u.days, 'день', 'дні', 'днів') + (u.events ? ', ' + u.events + ' ' + plural(u.events, 'подія', 'події', 'подій') : '')),
                        h('td', { 'data-label': 'Авто автопарку' }, sel),
                        h('td', { 'data-label': '' }, h('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'map', onclick: () => mapRef(u.ref, sel.value) }, 'Зіставити')));
                }))))
            : h('p', { class: 'muted' }, 'Незмепленої техніки немає: усі позначки зі звітів збіглися з держномерами автопарку.');
        const unitOf = (vid) => (state.vehicleUnits.find((x) => x.vehicle_id === vid) || {}).unit_id || '';
        const units = state.vehicles.length
            ? h('div', { class: 'table-wrap' }, h('table', { class: 'table kpof-table kpt-table', 'aria-label': 'Підрозділи авто' },
                h('thead', null, h('tr', null, ['Авто', 'Підрозділ'].map((t) => h('th', null, t)))),
                h('tbody', null, state.vehicles.map((v) => h('tr', null,
                    h('td', { 'data-label': 'Авто' }, v.label),
                    h('td', { 'data-label': 'Підрозділ' }, h('select', { 'aria-label': 'Підрозділ для ' + v.label, onchange: (e) => setUnit(v.id, e.target.value) },
                        h('option', { value: '' }, '— без підрозділу —'), state.units.map((u) => h('option', { value: u.id, selected: u.id === unitOf(v.id) }, u.name)))))))))
            : h('p', { class: 'muted' }, 'В автопарку ще немає авто.');
        return h('div', null,
            h('h3', { class: 'kpof-sub-h' }, 'Незмеплені авто'),
            h('p', { class: 'muted small' }, 'Позначка зі звіту (держномер або ID) зіставляється з автопарком автоматично за номером: літери А/A, В/B, Е/E, І/I, К/K, М/M, Н/H, О/O, Р/P, С/C, Т/T, Х/X однакові, пробіли й дефіси не враховуються. Решту оберіть вручну.'),
            unmapped,
            h('h3', { class: 'kpof-sub-h' }, 'Підрозділи авто'),
            h('p', { class: 'muted small' }, 'Потрібні для фільтра «Підрозділ» в огляді.'),
            units);
    }

    function paint() {
        const modeBtn = (m) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(state.mode === m.key), class: state.mode === m.key ? 'is-on' : '', 'data-mode': m.key,
            onclick: () => { if (state.mode === m.key) return; state.mode = m.key; paint(); } }, m.label + (m.key === 'mapping' && state.unmapped.length ? ' (' + state.unmapped.length + ')' : ''));
        let content;
        if (state.mode === 'import') {
            // Панель імпорту створюється один раз: перемальовування огляду не скидає вибраний файл і звіт.
            if (!importNode) importNode = renderTelematicsImport(app, { get templates() { return state.templates; }, ensureSource, onImported: () => { reload(); } });
            content = importNode;
        } else if (state.mode === 'mapping') content = mappingBlock();
        else content = overviewBlock();
        clear(root,
            h('div', { class: 'kpof-head' }, h('h2', { class: 'kpof-sub' }, 'Телематика (Агроконтроль)'),
                h('div', { class: 'kpof-actions' }, h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Розділ телематики' }, MODES.map(modeBtn)),
                    h('button', { type: 'button', class: 'btn', onclick: reload }, 'Оновити'))),
            sourcesBlock(), content);
    }

    reload();
    return root;
}
