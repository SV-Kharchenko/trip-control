// Вкладка «GPS» (етап 2a): підключення Wialon (Hosting / Local), картка статусу, юніти й мапінг на авто компанії.
// Власник — усі дії; директор — картка статусу й таблиця (перегляд); логіст та інші — лише таблиця (перегляд).
// Токен живе лише в полі форми до відправки: після відправки поле й змінна очищаються, у сховище браузера не йде.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { gpsAccess } from '../lib/gate.js';
import { gpsMessage } from '../../lib/gps/errors.js';
import { callGpsApi } from '../lib/gps-client.js';
import { renderGpsMap } from './gps-map.js';

export const GPS_REGIONS = [
    { value: 'com', label: 'hst-api.wialon.com (основний)' },
    { value: 'eu', label: 'hst-api.wialon.eu' },
    { value: 'us', label: 'hst-api.wialon.us' },
    { value: 'org', label: 'hst-api.wialon.org' },
];

const STATUS_LABELS = {
    active: 'Підключено',
    pending: 'Очікує перевірки',
    error_auth: 'Немає доступу (токен)',
    error: 'Помилка зʼєднання',
    disabled: 'Відключено',
};

const INTEGRATION_COLUMNS = 'id, status, host_kind, api_host, provider_account, units_total, token_hint, last_checked_at, last_ok_at, last_error_code';

export function gpsStatusLabel(status) {
    return STATUS_LABELS[status] || 'Невідомо';
}

export function minutesAgo(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '—';
    const min = Math.max(0, Math.floor((now - t) / 60000));
    if (min < 1) return 'щойно';
    if (min < 60) return min + ' хв тому';
    const hours = Math.floor(min / 60);
    if (hours < 24) return hours + ' год тому';
    return new Date(t).toLocaleDateString('uk-UA');
}

// Варіанти «Авто» для юніта: поточне авто юніта + вільні авто (не привʼязані до інших юнітів).
export function vehicleOptions(units, fleet, unitId) {
    const unit = units.find((u) => u.id === unitId);
    const taken = new Set(units.filter((u) => u.id !== unitId && u.vehicle_id).map((u) => u.vehicle_id));
    return fleet.filter((v) => !taken.has(v.id) || (unit && unit.vehicle_id === v.id));
}

// Посилання на форму видачі токена Wialon (токен зʼявиться в адресі як access_token=…). За документацією Wialon
// (help.wialon.com → API → Getting an access token) форма — це <host>/login.html на адресі вебінтерфейсу Wialon;
// окремих адрес форми для серверів API .com / .eu / .us / .org документація не наводить, тож для Hosting беремо
// hosting.wialon.com і прямо пишемо в підказці, що форма одна, а сервер API обирається окремо.
export const TOKEN_FORM_HINT = 'Форма видачі токена — сторінка login.html на адресі, через яку ви входите у Wialon. '
    + 'Для Wialon Hosting це hosting.wialon.com для всіх серверів API (.com / .eu / .us / .org обирається нижче окремо). '
    + 'Якщо ви входите у Wialon через іншу адресу (наприклад, домен партнера), відкрийте login.html на ній із тими самими параметрами.';

export function tokenLink({ kind, localUrl, login }) {
    const params = new URLSearchParams({
        client_id: 'TripControl', access_type: '256', activation_time: '0', duration: '0', lang: 'uk', flags: '0', user: login || '<логін>',
    });
    let base = 'https://hosting.wialon.com';
    if (kind === 'local') {
        try {
            const url = new URL(localUrl);
            base = url.protocol === 'https:' ? url.origin : 'https://<ваш-сервер-wialon>';
        } catch {
            base = 'https://<ваш-сервер-wialon>';
        }
    }
    return base + '/login.html?' + params.toString().replace(/%3C/g, '<').replace(/%3E/g, '>');
}

const callApi = callGpsApi;

export function renderGps(app) {
    const access = gpsAccess(app.context);
    const statusBox = h('div', { class: 'gps-status' });
    const unitsBox = h('div', { class: 'list' }, spinner());
    const state = { integration: null, units: [], fleet: [], suggestions: new Map(), busy: false };

    function connectForm() {
        const kindHosting = h('input', { type: 'radio', name: 'gps-kind', value: 'hosting', id: 'gps-kind-hosting', checked: true });
        const kindLocal = h('input', { type: 'radio', name: 'gps-kind', value: 'local', id: 'gps-kind-local' });
        const region = h('select', { id: 'gps-region' }, GPS_REGIONS.map((r) => h('option', { value: r.value }, r.label)));
        const localUrl = h('input', { id: 'gps-local-url', type: 'url', inputmode: 'url', placeholder: 'https://gps.ваша-компанія.ua', autocomplete: 'off', spellcheck: 'false', maxlength: '300' });
        const login = h('input', { id: 'gps-login', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'логін користувача Wialon', maxlength: '80' });
        const token = h('input', { id: 'gps-token', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'gps-token-hint', maxlength: '128' });
        const link = h('code', { class: 'mono gps-link' });
        const regionField = h('div', { class: 'field' }, h('label', { for: 'gps-region' }, 'Сервер Wialon Hosting'), region);
        const localField = h('div', { class: 'field' }, h('label', { for: 'gps-local-url' }, 'Адреса вашого сервера Wialon Local'), localUrl,
            h('span', { class: 'hint' }, 'Лише https:// з доменним імʼям, порт 443 або 8443. Потрібен дійсний сертифікат (самопідписаний не підтримується) і доступ до сервера з інтернету.'));
        const message = h('div', { 'aria-live': 'polite' });
        const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Підключити');

        function sync() {
            const local = kindLocal.checked;
            regionField.hidden = local;
            localField.hidden = !local;
            link.textContent = tokenLink({ kind: local ? 'local' : 'hosting', localUrl: localUrl.value, login: login.value.trim() });
        }
        for (const el of [kindHosting, kindLocal]) el.addEventListener('change', sync);
        for (const el of [localUrl, login]) el.addEventListener('input', sync);
        sync();

        const form = h('form', { class: 'card gps-form', novalidate: true, onsubmit: async (event) => {
            event.preventDefault();
            let value = token.value.trim();
            token.value = '';
            if (!/^[0-9A-Za-z]{32,128}$/.test(value)) {
                value = null;
                clear(message, notice('Токен має містити 32–128 латинських літер і цифр. Скопіюйте його з адреси після access_token=.'));
                return;
            }
            const body = kindLocal.checked ? { localUrl: localUrl.value.trim(), token: value } : { region: region.value, token: value };
            value = null;
            submit.disabled = true;
            clear(message, spinner('Перевіряємо підключення до Wialon…'));
            const out = await callApi(app, 'connect', body);
            body.token = null;
            submit.disabled = false;
            if (!out.ok) {
                clear(message, notice(out.error));
                return;
            }
            clear(message);
            toast('GPS підключено');
            await load();
        } },
        h('h2', null, 'Підключити Wialon'),
        h('div', { class: 'gps-kind', role: 'radiogroup', 'aria-label': 'Тип Wialon' },
            h('label', { class: 'check', for: 'gps-kind-hosting' }, kindHosting, ' Wialon Hosting'),
            h('label', { class: 'check', for: 'gps-kind-local' }, kindLocal, ' Wialon Local (власний сервер)')),
        h('ol', { class: 'gps-steps small' },
            h('li', null, 'Створіть у Wialon окремого користувача лише з правом ', h('b', null, 'перегляду'), ' потрібних обʼєктів (авто).'),
            h('li', null, 'Увійдіть цим користувачем за посиланням нижче (підставте логін) і підтвердьте доступ.',
                h('div', { class: 'field' }, h('label', { for: 'gps-login' }, 'Логін користувача Wialon (для посилання)'), login), link,
                h('span', { class: 'hint gps-form-hint' }, TOKEN_FORM_HINT)),
            h('li', null, 'Після входу токен буде в адресному рядку після ', h('code', null, 'access_token='), '. Скопіюйте лише його.'),
            h('li', null, 'Ніколи не надсилайте токен у чат чи пошту — лише в це поле.')),
        h('div', { class: 'form' }, regionField, localField,
            h('div', { class: 'field' }, h('label', { for: 'gps-token' }, 'Токен Wialon'), token,
                h('span', { class: 'hint', id: 'gps-token-hint' }, 'Зберігається зашифровано у сховищі секретів; тут показуємо лише останні 4 символи.')),
            message,
            h('div', { class: 'actions' }, submit)));
        return form;
    }

    function statusCard() {
        const it = state.integration;
        const actions = h('div', { class: 'actions' });
        const message = h('div', { 'aria-live': 'polite' });
        const run = (label, route, after) => h('button', { type: 'button', class: 'btn', onclick: async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            clear(message, spinner(label + '…'));
            const out = await callApi(app, route);
            button.disabled = false;
            if (!out.ok) {
                clear(message, notice(out.error));
                return;
            }
            clear(message, out.message ? notice(out.message) : null);
            await after(out);
        } }, label);
        if (access.canManage) {
            actions.append(
                run('Перевірити підключення', 'test', async (out) => { if (out.ok !== false) toast('Підключення працює'); await load(); }),
                run('Оновити список юнітів', 'sync-units', async (out) => {
                    if (out.ok === false) return load();
                    state.suggestions = new Map((out.units || []).filter((u) => u.suggested_vehicle_id).map((u) => [u.id, u.suggested_vehicle_id]));
                    toast('Юнітів: ' + out.counts.total + ' (нових ' + out.counts.added + ', неактивних ' + out.counts.deactivated + ')');
                    await load(true);
                }),
                confirmButton('Відключити', 'Точно відключити? Токен буде видалено', async () => {
                    const out = await callApi(app, 'disconnect');
                    if (!out.ok) clear(message, notice(out.error));
                    else {
                        toast('GPS відключено');
                        await load();
                    }
                }));
        }
        const row = (label, value) => h('div', { class: 'gps-row' }, h('span', { class: 'muted' }, label), h('b', null, value));
        return h('div', { class: 'card gps-card' },
            h('div', { class: 'page-head' },
                h('h2', null, 'Wialon ' + (it.host_kind === 'local' ? 'Local' : 'Hosting')),
                h('span', { class: 'badge gps-badge gps-' + it.status }, gpsStatusLabel(it.status))),
            h('div', { class: 'gps-rows' },
                row('Сервер', it.api_host),
                row('Акаунт Wialon', it.provider_account || '—'),
                row('Юнітів', it.units_total == null ? '—' : String(it.units_total)),
                row('Перевірено', minutesAgo(it.last_checked_at)),
                row('Токен', it.token_hint || '—')),
            it.last_error_code && it.status !== 'active' ? notice(gpsMessage(it.last_error_code)) : null,
            message,
            actions);
    }

    function drawStatus() {
        if (!access.seesIntegration) {
            clear(statusBox);
            return;
        }
        const it = state.integration;
        // 'pending' без токена — лише слід невдалої спроби (ліміт перебору): показуємо форму, а не картку.
        if (!it || it.status === 'disabled' || (it.status === 'pending' && !it.token_hint)) {
            if (access.canManage) clear(statusBox, connectForm());
            else clear(statusBox, notice('GPS ще не підключено. Підключає власник компанії.', 'info'));
            return;
        }
        clear(statusBox, statusCard());
    }

    async function mapUnit(unitId, vehicleId, inline) {
        const { error } = await app.supabase.rpc('gps_map_vehicle', { p_gps_vehicle: unitId, p_vehicle: vehicleId || null });
        if (error) {
            if (inline) clear(inline, h('span', { class: 'hint hint-error' }, errorText(error)));
            return false;
        }
        state.suggestions.delete(unitId);
        return true;
    }

    function drawUnits() {
        const { units, fleet, suggestions } = state;
        if (!units.length) {
            clear(unitsBox, h('p', { class: 'muted empty' }, access.canManage && state.integration && state.integration.status !== 'disabled'
                ? 'Юнітів ще немає — натисніть «Оновити список юнітів».'
                : 'Юнітів ще немає.'));
            return;
        }
        const label = (id) => (fleet.find((v) => v.id === id) || {}).label;
        const acceptAll = access.canManage && suggestions.size
            ? h('button', { type: 'button', class: 'btn btn-sm', onclick: async (event) => {
                event.currentTarget.disabled = true;
                for (const [unitId, vehicleId] of [...suggestions]) await mapUnit(unitId, vehicleId, null);
                toast('Підказки застосовано');
                await load(true);
            } }, 'Прийняти всі підказки (' + suggestions.size + ')')
            : null;
        const rows = units.map((u) => {
            const inline = h('div', { 'aria-live': 'polite' });
            let cell;
            if (access.canManage) {
                const suggested = suggestions.get(u.id);
                const select = h('select', { 'aria-label': 'Авто для юніта ' + u.name, onchange: async (event) => {
                    clear(inline);
                    event.currentTarget.disabled = true;
                    if (await mapUnit(u.id, event.currentTarget.value, inline)) {
                        toast(event.currentTarget.value ? 'Авто привʼязано' : 'Привʼязку знято');
                        await load(true);
                    } else event.currentTarget.disabled = false;
                } },
                h('option', { value: '' }, '— не привʼязано —'),
                vehicleOptions(units, fleet, u.id).map((v) => h('option', { value: v.id, selected: v.id === u.vehicle_id },
                    v.label + (v.id === suggested ? ' — запропоновано' : ''))));
                cell = h('td', null, select,
                    suggested ? h('span', { class: 'tag tag-suggest' }, 'Запропоновано: ' + (label(suggested) || '')) : null, inline);
            } else {
                cell = h('td', null, u.vehicle_label || '—');
            }
            return h('tr', { class: u.active ? '' : 'is-archived' },
                h('td', null, u.name || '—', u.active ? null : h('span', { class: 'tag' }, 'немає у Wialon')),
                cell,
                h('td', { class: 'mono small' }, u.external_id));
        });
        clear(unitsBox,
            acceptAll ? h('div', { class: 'toolbar' }, acceptAll, h('span', { class: 'muted small' }, 'Підказки — за збігом назви юніта з номером авто. Без кнопки нічого не змінюється.')) : null,
            h('div', { class: 'table-wrap' }, h('table', { class: 'table gps-units' },
                h('thead', null, h('tr', null, h('th', null, 'Юніт Wialon'), h('th', null, 'Авто'), h('th', null, 'ID'))),
                h('tbody', null, rows))));
    }

    async function load(keepSuggestions) {
        if (!keepSuggestions) state.suggestions = new Map();
        const tasks = [app.supabase.rpc('gps_units')];
        tasks.push(access.seesIntegration
            ? app.supabase.from('gps_integrations').select(INTEGRATION_COLUMNS).eq('provider', 'wialon').maybeSingle()
            : Promise.resolve({ data: null, error: null }));
        tasks.push(access.canManage
            ? app.supabase.from('fleet_vehicles').select('id, label').order('label', { ascending: true }).limit(1000)
            : Promise.resolve({ data: [], error: null }));
        const [units, integration, fleet] = await Promise.all(tasks);
        const error = units.error || integration.error || fleet.error;
        if (error) {
            if (isPlanError(error)) return app.onPlanLost();
            clear(unitsBox, notice(errorText(error)));
            return;
        }
        state.units = units.data || [];
        state.integration = integration.data || null;
        state.fleet = fleet.data || [];
        // Підказки лише для юнітів, які досі без авто, і лише на вільні авто.
        for (const [unitId, vehicleId] of [...state.suggestions]) {
            const unit = state.units.find((u) => u.id === unitId);
            if (!unit || unit.vehicle_id || state.units.some((u) => u.vehicle_id === vehicleId)) state.suggestions.delete(unitId);
        }
        drawStatus();
        drawUnits();
    }

    load();

    // Карта (етап 2c) — для всіх ролей організації на control_plus; власника «До форми підключення» веде до форми нижче.
    const map = renderGpsMap(app, { onConnect: () => statusBox.scrollIntoView({ behavior: 'smooth', block: 'start' }) });

    return h('section', { class: 'page gps-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'GPS')),
        access.canManage ? null : notice(access.seesIntegration
            ? 'Режим перегляду: підключенням і привʼязкою авто керує власник компанії.'
            : 'Режим перегляду: юніти GPS і привʼязка до авто вашої компанії.', 'info'),
        map,
        access.seesIntegration ? h('h2', { class: 'section-title' }, access.canManage ? 'Підключення' : 'Підключення (перегляд)') : null,
        statusBox,
        h('h2', { class: 'section-title' }, 'Юніти й авто'),
        unitsBox);
}
