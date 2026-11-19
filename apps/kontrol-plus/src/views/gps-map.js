// Підрозділ «Карта» вкладки GPS (етап 2c): авто з поточною заявкою. Дані — POST /api/gps/positions (сервер сам
// оновлює їх з Wialon не частіше разу на хвилину). Leaflet вантажиться лише тут (динамічний import) і знищується
// при виході з розділу; тайли OpenStreetMap — без префетчу й офлайн-кешу. Маркери — L.divIcon (HTML), без PNG.
import { h, clear, notice } from '../ui.js';
import { callGpsApi } from '../lib/gps-client.js';
import { gpsAccess } from '../lib/gate.js';
import { errorText } from '../lib/errors.js';
import { KIND_LABELS } from '../../lib/gps/kind.js';
import { KIND_OPTIONS, emptySelection, fetchCatalog, loadSelection, pruneSelection, saveSelection, searchUnits, selectionBody, unitTitle } from '../lib/gps-catalog.js';

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const MAX_ZOOM = 19;
const DEFAULT_VIEW = { center: [49.0, 31.4], zoom: 6 }; // Україна

const KYIV_PARTS = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23',
});

function kyivParts(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return null;
    return Object.fromEntries(KYIV_PARTS.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
}

// «HH:MM DD.MM» за Києвом.
export function formatKyivDateTime(iso) {
    const p = kyivParts(iso);
    return p ? `${p.hour}:${p.minute} ${p.day}.${p.month}` : '—';
}

export function formatKyivTime(iso) {
    const p = kyivParts(iso);
    return p ? `${p.hour}:${p.minute}` : '—';
}

export function minutesAgoText(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const min = Math.max(0, Math.floor((now - t) / 60000));
    if (min < 1) return 'щойно';
    if (min < 60) return min + ' хв тому';
    const hours = Math.floor(min / 60);
    return hours < 48 ? hours + ' год тому' : Math.floor(hours / 24) + ' дн тому';
}

export function speedText(speed) {
    return speed === null || speed === undefined || !Number.isFinite(Number(speed)) ? '—' : Math.round(Number(speed)) + ' км/год';
}

export function hasCoords(v) {
    return Number.isFinite(v && v.lat) && Number.isFinite(v && v.lon);
}

// Спершу авто з сигналом, далі за номером (природний порядок); без координат — у кінці своєї групи.
export function sortMapVehicles(vehicles) {
    const label = (v) => String(v.plate || v.unit_name || '');
    return [...(vehicles || [])].sort((a, b) => {
        if (Boolean(a.no_signal) !== Boolean(b.no_signal)) return a.no_signal ? 1 : -1;
        if (hasCoords(a) !== hasCoords(b)) return hasCoords(a) ? -1 : 1;
        return label(a).localeCompare(label(b), 'uk', { numeric: true, sensitivity: 'base' });
    });
}

export function orderText(order) {
    if (!order) return 'без активної заявки';
    const route = [order.route_from, order.route_to].filter(Boolean).join(' → ') || 'маршрут не вказано';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(order.trip_date || '') ? order.trip_date.slice(8, 10) + '.' + order.trip_date.slice(5, 7) : '';
    return [date, route, order.client_name].filter(Boolean).join(' · ');
}

// Повідомлення над картою за станом відповіді. kind: 'info' | 'error'; action: 'connect' — кнопка до форми (owner).
export function mapStateNotice({ status, vehicles, networkError, refreshError, refreshErrorCode, canManage, customSelection }) {
    if (networkError) return { kind: 'error', text: 'Не вдалося завантажити карту. Перевірте інтернет і спробуйте ще раз.' };
    if (status === 'not_connected' || status === 'pending' || !status) {
        return canManage
            ? { kind: 'info', text: 'GPS ще не підключено. Підключіть Wialon у формі нижче.', action: 'connect' }
            : { kind: 'info', text: 'GPS ще не підключено. Попросіть директора підключити GPS.' };
    }
    if (status === 'error_auth') {
        return { kind: 'error', text: 'Немає доступу до Wialon: токен недійсний або відкликаний. '
            + (canManage ? 'Перевірте підключення нижче.' : 'Попросіть директора оновити токен.') + ' Показано останні відомі дані.' };
    }
    if (!vehicles || !vehicles.length) {
        if (refreshError) return { kind: 'error', text: refreshError + (refreshErrorCode ? ' (код: ' + refreshErrorCode + ')' : '') };
        if (customSelection) return { kind: 'info', text: 'За вибраними умовами юнітів немає. Змініть групи, юніти або тип.' };
        return { kind: 'info', text: canManage ? 'Немає привʼязаних авто. Привʼяжіть юніти Wialon до авто в таблиці нижче.' : 'Немає привʼязаних авто.' };
    }
    if (refreshError) return { kind: 'error', text: refreshError + (refreshErrorCode ? ' (код: ' + refreshErrorCode + ')' : '') + ' Показано останні відомі дані.' };
    if (!vehicles.some(hasCoords)) return { kind: 'info', text: 'Ще немає даних про позиції авто. Натисніть «Оновити».' };
    return null;
}

// Текст біля кнопки «Оновити».
export function refreshStatusText(result, now = Date.now()) {
    if (!result) return '';
    if (result.refreshed) return 'Оновлено ' + formatKyivTime(new Date(now).toISOString());
    const next = Date.parse(result.next_refresh_at || '');
    if (Number.isFinite(next) && next > now) return 'Наступне оновлення через ' + Math.ceil((next - now) / 1000) + ' с';
    return '';
}

export function mapSectionVisible(context) {
    return gpsAccess(context).visible;
}

export function kindText(kind) {
    return kind && KIND_LABELS[kind] ? KIND_LABELS[kind] : 'Тип не визначено';
}

// Мітка на карті: привʼязаний юніт — номер з Автопарку, непривʼязаний — назва з Wialon.
export function markerLabel(v) {
    return (v.linked !== false && v.plate) || v.unit_name || v.plate || '—';
}

// Коротко для мітки: «Київ → Одеса» (клієнт — у попапі).
export function orderShort(order) {
    if (!order) return '';
    return [order.route_from, order.route_to].filter(Boolean).join(' → ') || 'заявка без маршруту';
}

function markerElement(v) {
    return h('div', { class: 'kp-marker ' + (v.no_signal ? 'is-nosignal' : 'is-ok') + (v.linked === false ? ' is-unlinked' : '') },
        h('b', null, markerLabel(v)),
        h('span', null, v.no_signal ? 'немає сигналу' : speedText(v.speed)),
        v.order ? h('span', { class: 'kp-marker-order' }, orderShort(v.order)) : null);
}

function popupElement(v, now) {
    return h('div', { class: 'kp-popup' },
        h('b', null, markerLabel(v)),
        v.linked !== false && v.unit_name ? h('div', { class: 'muted' }, v.unit_name) : null,
        v.linked === false ? h('div', { class: 'muted' }, 'Не привʼязано до Автопарку') : null,
        h('div', { class: 'muted' }, kindText(v.kind) + (v.kind_manual ? ' (вручну)' : '')),
        h('div', null, 'Швидкість: ' + speedText(v.speed)),
        h('div', null, 'Востаннє: ' + formatKyivDateTime(v.last_pos_at) + (v.last_pos_at ? ' (' + minutesAgoText(v.last_pos_at, now) + ')' : '')),
        v.no_signal ? h('div', { class: 'kp-nosignal' }, 'Немає сигналу понад 30 хв') : null,
        v.linked === false ? null : h('div', { class: 'kp-popup-order' }, h('span', { class: 'muted' }, 'Заявка: '), orderText(v.order),
            v.more_orders ? h('span', { class: 'tag' }, '+' + v.more_orders) : null));
}

// Рядок стану синхронізації: статус підключення, час останнього успіху, код помилки (помилку не ховаємо).
export function syncStatusText(out, now = Date.now()) {
    if (!out) return '';
    const parts = [];
    const status = out.integration_status;
    parts.push('Wialon: ' + (status === 'active' ? 'підключено' : status === 'error_auth' ? 'немає доступу' : status === 'error' ? 'помилка зʼєднання'
        : status === 'pending' ? 'очікує перевірки' : 'не підключено'));
    const sync = out.sync || {};
    if (sync.last_ok_at) parts.push('дані з Wialon ' + formatKyivTime(sync.last_ok_at) + ' (' + minutesAgoText(sync.last_ok_at, now) + ')');
    const code = out.refresh_error_code || (status !== 'active' ? sync.last_error_code : null);
    if (code) parts.push('код помилки: ' + code);
    return parts.join(' · ');
}

// Випадний список із прапорцями (групи, тип). draw(options, selectedValues) перемальовує список.
function multiPick({ label, onChange }) {
    const box = h('div', { class: 'gps-multi-list' });
    const summary = h('summary', { class: 'btn btn-sm' });
    const element = h('details', { class: 'gps-multi' }, summary, box);
    function draw(options, selected) {
        const chosen = new Set(selected);
        summary.textContent = label + (chosen.size ? ': ' + chosen.size : '');
        if (!options.length) {
            clear(box, h('span', { class: 'muted small' }, 'Немає варіантів'));
            return;
        }
        clear(box, options.map((o) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', value: o.value, checked: chosen.has(o.value), onchange: (event) => {
                const next = new Set(chosen);
                if (event.currentTarget.checked) next.add(o.value);
                else next.delete(o.value);
                onChange([...next]);
            } }),
            ' ' + o.label)));
    }
    return { element, draw };
}

export function renderGpsMap(app, { onConnect } = {}) {
    const access = gpsAccess(app.context);
    const orgId = app.context && app.context.org_id;
    const banner = h('div', { 'aria-live': 'polite' });
    const status = h('span', { class: 'muted small', 'aria-live': 'polite' });
    const syncLine = h('div', { class: 'gps-sync small', 'aria-live': 'polite' });
    const mapEl = h('div', { class: 'gps-map', role: 'region', 'aria-label': 'Карта авто' });
    const list = h('ul', { class: 'gps-map-list', 'aria-label': 'Авто на карті' });
    const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(true) }, 'Оновити');
    const wrap = h('div', { class: 'gps-map-wrap' }, mapEl, list);
    const state = { map: null, L: null, layer: null, markers: new Map(), disposed: false, fitted: false, seq: 0,
        catalog: { units: [], groups: [] }, selection: loadSelection(orgId), catalogError: null };

    // --- Вибір: групи (мультиселект), окремі юніти (пошук), тип, «Усі юніти» ---
    const groupPick = multiPick({ label: 'Групи', onChange: (ids) => change({ groupIds: ids, all: false }) });
    const kindPick = multiPick({ label: 'Тип', onChange: (kinds) => change({ kinds }) });
    const search = h('input', { type: 'search', class: 'gps-unit-search', placeholder: 'Юніт: назва або номер', 'aria-label': 'Пошук юніта за назвою або номером',
        autocomplete: 'off', maxlength: '60', oninput: () => drawResults() });
    const results = h('ul', { class: 'gps-unit-results', 'aria-label': 'Знайдені юніти' });
    const chips = h('div', { class: 'gps-chips' });
    const allBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => change({ all: !state.selection.all }) }, 'Усі юніти');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => {
        state.selection = emptySelection();
        persist();
    } }, 'Скинути вибір');
    const hint = h('div', { class: 'muted small gps-filter-hint' });
    const filters = h('div', { class: 'gps-filter card' },
        h('div', { class: 'gps-filter-row' }, groupPick.element,
            h('div', { class: 'gps-unit-pick' }, search, results), kindPick.element,
            h('div', { class: 'actions' }, allBtn, resetBtn)),
        chips, hint);

    function persist() {
        state.fitted = false;
        saveSelection(orgId, state.selection);
        drawFilters();
        load(false);
    }

    function change(patch) {
        state.selection = { ...state.selection, ...patch };
        persist();
    }

    function drawResults() {
        const found = searchUnits(state.catalog.units, search.value);
        const picked = new Set(state.selection.unitIds);
        clear(results, found.map((u) => h('li', null, h('button', { type: 'button', class: 'gps-unit-result', disabled: picked.has(u.id), onclick: () => {
            search.value = '';
            clear(results);
            change({ unitIds: [...state.selection.unitIds, u.id], all: false });
        } }, unitTitle(u)))));
    }

    function drawFilters() {
        const sel = state.selection;
        groupPick.draw(state.catalog.groups.map((g) => ({ value: g.id, label: g.name + ' (' + g.count + ')' })), sel.groupIds);
        kindPick.draw(KIND_OPTIONS, sel.kinds);
        allBtn.setAttribute('aria-pressed', sel.all ? 'true' : 'false');
        allBtn.classList.toggle('btn-primary', sel.all);
        const byId = new Map(state.catalog.units.map((u) => [u.id, u]));
        clear(chips, sel.unitIds.map((id) => h('span', { class: 'tag gps-chip' }, byId.has(id) ? unitTitle(byId.get(id)) : 'юніт',
            h('button', { type: 'button', class: 'gps-chip-x', 'aria-label': 'Прибрати юніт з вибору', onclick: () => change({ unitIds: sel.unitIds.filter((x) => x !== id) }) }, '×'))));
        const custom = sel.all || sel.groupIds.length || sel.unitIds.length;
        hint.textContent = custom
            ? 'Вибір зберігається в цьому браузері.'
            : 'Нічого не вибрано — показано лише привʼязані до Автопарку авто. Виберіть групу, юніти або «Усі юніти».';
    }

    async function loadCatalog() {
        const catalog = await fetchCatalog(app.supabase);
        if (state.disposed) return;
        if (catalog.error) {
            // Помилку не ховаємо: текст над картою, вибір лишається як є.
            clear(banner, notice('Не вдалося завантажити групи й юніти: ' + errorText(catalog.error)));
            return;
        }
        state.catalog = catalog;
        const pruned = pruneSelection(state.selection, catalog);
        const changed = JSON.stringify(pruned) !== JSON.stringify(state.selection);
        state.selection = pruned;
        if (changed) saveSelection(orgId, pruned);
        drawFilters();
        drawResults();
        if (changed) load(false);
    }

    if (app.onCleanup) {
        app.onCleanup(() => {
            state.disposed = true;
            if (state.map) state.map.remove();
            state.map = null;
        });
    }

    async function ensureMap() {
        if (state.map || state.disposed) return state.map;
        const [mod] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
        if (state.disposed) return null;
        const L = mod.default || mod;
        state.L = L;
        state.map = L.map(mapEl, { center: DEFAULT_VIEW.center, zoom: DEFAULT_VIEW.zoom, maxZoom: MAX_ZOOM, worldCopyJump: true });
        L.tileLayer(OSM_TILES, { maxZoom: MAX_ZOOM, attribution: OSM_ATTRIBUTION }).addTo(state.map);
        state.layer = L.layerGroup().addTo(state.map);
        return state.map;
    }

    function focus(v) {
        const marker = state.markers.get(v.gps_vehicle_id);
        if (!state.map || !marker) return;
        state.map.setView([v.lat, v.lon], Math.max(state.map.getZoom(), 13));
        marker.openPopup();
    }

    function drawList(vehicles) {
        const now = Date.now();
        clear(list, sortMapVehicles(vehicles).map((v) => h('li', null,
            h('button', { type: 'button', class: 'gps-map-item ' + (v.no_signal ? 'is-nosignal' : 'is-ok'), disabled: !hasCoords(v),
                onclick: () => focus(v) },
            h('span', { class: 'dot', 'aria-hidden': 'true' }),
            h('span', { class: 'gps-map-main' },
                h('b', null, markerLabel(v)),
                h('span', { class: 'muted small' }, kindText(v.kind) + (v.linked === false ? ' · не привʼязано' : '')),
                h('span', { class: 'muted small' }, hasCoords(v)
                    ? (v.no_signal ? 'немає сигналу · ' : speedText(v.speed) + ' · ') + formatKyivDateTime(v.last_pos_at) + ' (' + minutesAgoText(v.last_pos_at, now) + ')'
                    : 'немає даних'),
                v.linked === false ? null : h('span', { class: 'small' }, orderText(v.order), v.more_orders ? ' +' + v.more_orders : ''))))));
    }

    function drawMarkers(vehicles) {
        const { L, map, layer } = state;
        if (!L || !map) return;
        layer.clearLayers();
        state.markers.clear();
        const now = Date.now();
        const points = [];
        for (const v of vehicles) {
            if (!hasCoords(v)) continue;
            const marker = L.marker([v.lat, v.lon], {
                // Мітка стоїть над точкою (CSS translate -50% / -100%), тож popup — ще вище, щоб її не закривати.
                icon: L.divIcon({ className: 'kp-marker-wrap', html: markerElement(v), iconSize: null, iconAnchor: [0, 0], popupAnchor: [0, -44] }),
                title: markerLabel(v),
                keyboard: true,
            }).bindPopup(popupElement(v, now));
            marker.addTo(layer);
            state.markers.set(v.gps_vehicle_id, marker);
            points.push([v.lat, v.lon]);
        }
        if (points.length && !state.fitted) {
            map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
            state.fitted = true;
        }
        map.invalidateSize();
    }

    async function load(refresh) {
        const seq = ++state.seq;
        refreshBtn.disabled = true;
        status.textContent = refresh ? 'Оновлюю…' : 'Завантажую…';
        const out = await callGpsApi(app, 'positions', selectionBody(state.selection, refresh));
        if (state.disposed || seq !== state.seq) return;
        refreshBtn.disabled = false;
        if (!out.ok && out.status !== 429) {
            if (out.code === 'CONTROL_PLUS_REQUIRED' && app.onPlanLost) return app.onPlanLost();
            status.textContent = '';
            syncLine.textContent = out.code ? 'Код помилки: ' + out.code : '';
            clear(banner, notice(out.network ? mapStateNotice({ networkError: true }).text : out.error));
            return;
        }
        const vehicles = out.vehicles || [];
        const sel = state.selection;
        const custom = sel.all || sel.groupIds.length > 0 || sel.unitIds.length > 0 || sel.kinds.length > 0;
        const msg = mapStateNotice({ status: out.integration_status, vehicles, refreshError: out.refresh_error, refreshErrorCode: out.refresh_error_code,
            canManage: access.canManage, customSelection: custom });
        clear(banner, msg ? h('div', { class: 'notice notice-' + msg.kind, role: msg.kind === 'error' ? 'alert' : 'status' }, msg.text,
            msg.action === 'connect' && onConnect ? h('button', { type: 'button', class: 'btn btn-sm gps-to-form', onclick: onConnect }, 'До форми підключення') : null) : null);
        status.textContent = refreshStatusText(out);
        syncLine.textContent = syncStatusText(out) + (vehicles.length ? ' · на карті: ' + vehicles.filter(hasCoords).length + ' з ' + vehicles.length : '');
        drawList(vehicles);
        // GPS не підключено і даних немає — без порожньої карти, фільтрів і кнопки «Оновити».
        const nothing = out.integration_status === 'not_connected' && !vehicles.length;
        wrap.hidden = nothing;
        refreshBtn.hidden = nothing;
        filters.hidden = nothing;
        if (!nothing) {
            try {
                await ensureMap();
            } catch {
                clear(banner, notice('Не вдалося завантажити карту. Оновіть сторінку.'));
                return;
            }
            if (seq === state.seq) drawMarkers(vehicles);
        }
    }

    drawFilters();
    loadCatalog();
    load(false);

    const section = h('section', { class: 'gps-map-section', 'aria-label': 'Карта' },
        h('div', { class: 'page-head' }, h('h2', null, 'Карта'), h('div', { class: 'actions' }, status, refreshBtn)),
        filters,
        banner,
        syncLine,
        wrap);
    // Після виправлення типу юніта на вкладці каталог перечитується без перезавантаження сторінки.
    section.reloadCatalog = loadCatalog;
    return section;
}
