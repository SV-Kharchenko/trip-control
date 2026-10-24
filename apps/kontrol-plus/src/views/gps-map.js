// Підрозділ «Карта» вкладки GPS (етап 2c): авто з поточною заявкою. Дані — POST /api/gps/positions (сервер сам
// оновлює їх з Wialon не частіше разу на хвилину). Leaflet вантажиться лише тут (динамічний import) і знищується
// при виході з розділу; тайли OpenStreetMap — без префетчу й офлайн-кешу. Маркери — L.divIcon (HTML), без PNG.
import { h, clear, notice } from '../ui.js';
import { callGpsApi } from '../lib/gps-client.js';
import { gpsAccess } from '../lib/gate.js';

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

// Повідомлення над картою за станом відповіді. kind: 'info' | 'error'; action: 'connect' — кнопка до форми (власник).
export function mapStateNotice({ status, vehicles, networkError, refreshError, canManage }) {
    if (networkError) return { kind: 'error', text: 'Не вдалося завантажити карту. Перевірте інтернет і спробуйте ще раз.' };
    if (status === 'not_connected' || status === 'pending' || !status) {
        return canManage
            ? { kind: 'info', text: 'GPS ще не підключено. Підключіть Wialon у формі нижче.', action: 'connect' }
            : { kind: 'info', text: 'GPS ще не підключено. Попросіть власника підключити GPS.' };
    }
    if (status === 'error_auth') {
        return { kind: 'error', text: 'Немає доступу до Wialon: токен недійсний або відкликаний. '
            + (canManage ? 'Перевірте підключення нижче.' : 'Попросіть власника оновити токен.') + ' Показано останні відомі дані.' };
    }
    if (!vehicles || !vehicles.length) {
        return { kind: 'info', text: canManage ? 'Немає привʼязаних авто. Привʼяжіть юніти Wialon до авто в таблиці нижче.' : 'Немає привʼязаних авто.' };
    }
    if (refreshError) return { kind: 'error', text: refreshError + ' Показано останні відомі дані.' };
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

function markerElement(v) {
    return h('div', { class: 'kp-marker ' + (v.no_signal ? 'is-nosignal' : 'is-ok') },
        h('b', null, v.plate || v.unit_name || '—'),
        h('span', null, v.no_signal ? 'немає сигналу' : speedText(v.speed)));
}

function popupElement(v, now) {
    return h('div', { class: 'kp-popup' },
        h('b', null, v.plate || '—'), v.unit_name ? h('div', { class: 'muted' }, v.unit_name) : null,
        h('div', null, 'Швидкість: ' + speedText(v.speed)),
        h('div', null, 'Востаннє: ' + formatKyivDateTime(v.last_pos_at) + (v.last_pos_at ? ' (' + minutesAgoText(v.last_pos_at, now) + ')' : '')),
        v.no_signal ? h('div', { class: 'kp-nosignal' }, 'Немає сигналу понад 30 хв') : null,
        h('div', { class: 'kp-popup-order' }, h('span', { class: 'muted' }, 'Заявка: '), orderText(v.order),
            v.more_orders ? h('span', { class: 'tag' }, '+' + v.more_orders) : null));
}

export function renderGpsMap(app, { onConnect } = {}) {
    const access = gpsAccess(app.context);
    const banner = h('div', { 'aria-live': 'polite' });
    const status = h('span', { class: 'muted small', 'aria-live': 'polite' });
    const mapEl = h('div', { class: 'gps-map', role: 'region', 'aria-label': 'Карта авто' });
    const list = h('ul', { class: 'gps-map-list', 'aria-label': 'Авто на карті' });
    const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(true) }, 'Оновити');
    const wrap = h('div', { class: 'gps-map-wrap' }, mapEl, list);
    const state = { map: null, L: null, layer: null, markers: new Map(), disposed: false, fitted: false };

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
                h('b', null, v.plate || v.unit_name || '—'),
                h('span', { class: 'muted small' }, hasCoords(v)
                    ? (v.no_signal ? 'немає сигналу · ' : speedText(v.speed) + ' · ') + formatKyivDateTime(v.last_pos_at) + ' (' + minutesAgoText(v.last_pos_at, now) + ')'
                    : 'немає даних'),
                h('span', { class: 'small' }, orderText(v.order), v.more_orders ? ' +' + v.more_orders : ''))))));
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
                title: v.plate || v.unit_name || '',
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
        refreshBtn.disabled = true;
        status.textContent = refresh ? 'Оновлюю…' : 'Завантажую…';
        const out = await callGpsApi(app, 'positions', { refresh: Boolean(refresh) });
        if (state.disposed) return;
        refreshBtn.disabled = false;
        if (!out.ok && out.status !== 429) {
            if (out.code === 'CONTROL_PLUS_REQUIRED' && app.onPlanLost) return app.onPlanLost();
            status.textContent = '';
            clear(banner, notice(out.network ? mapStateNotice({ networkError: true }).text : out.error));
            return;
        }
        const vehicles = out.vehicles || [];
        const msg = mapStateNotice({ status: out.integration_status, vehicles, refreshError: out.refresh_error, canManage: access.canManage });
        clear(banner, msg ? h('div', { class: 'notice notice-' + msg.kind, role: msg.kind === 'error' ? 'alert' : 'status' }, msg.text,
            msg.action === 'connect' && onConnect ? h('button', { type: 'button', class: 'btn btn-sm gps-to-form', onclick: onConnect }, 'До форми підключення') : null) : null);
        status.textContent = refreshStatusText(out);
        drawList(vehicles);
        // GPS не підключено і даних немає — без порожньої карти й кнопки «Оновити».
        const nothing = out.integration_status === 'not_connected' && !vehicles.length;
        wrap.hidden = nothing;
        refreshBtn.hidden = nothing;
        if (!nothing) {
            try {
                await ensureMap();
            } catch {
                clear(banner, notice('Не вдалося завантажити карту. Оновіть сторінку.'));
                return;
            }
            drawMarkers(vehicles);
        }
    }

    load(false);

    return h('section', { class: 'gps-map-section', 'aria-label': 'Карта' },
        h('div', { class: 'page-head' }, h('h2', null, 'Карта'), h('div', { class: 'actions' }, status, refreshBtn)),
        banner,
        wrap);
}
