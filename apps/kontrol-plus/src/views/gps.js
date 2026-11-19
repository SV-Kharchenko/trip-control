// Вкладка «GPS» (етап 2a): підключення Wialon (Hosting / Local), картка статусу, юніти й мапінг на авто компанії.
// owner — усі дії; director — картка статусу й таблиця (перегляд); логіст та інші — лише таблиця (перегляд).
// Токен живе лише в полі форми до відправки: після відправки поле й змінна очищаються, у сховище браузера не йде.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { gpsAccess, gpsCanEditKinds } from '../lib/gate.js';
import {
    KIND_OPTIONS, LINK_OPTIONS, TABLE_PAGE, emptyTableFilters, filterUnitRows, loadTableFilters, pruneTableFilters, saveTableFilters, tableFiltersActive,
} from '../lib/gps-catalog.js';
import { KIND_LABELS } from '../../lib/gps/kind.js';
import { gpsMessage } from '../../lib/gps/errors.js';
import { callGpsApi } from '../lib/gps-client.js';
import { multiPick, renderGpsMap } from './gps-map.js';

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

const INTEGRATION_COLUMNS = 'id, provider, status, host_kind, api_host, provider_account, units_total, token_hint, last_checked_at, last_ok_at, last_error_code';

// Провайдери GPS у списку вибору. Агроконтроль — лише збереження доступу: інтеграції ще немає.
export const GPS_PROVIDERS = [
    { value: 'wialon', label: 'Wialon' },
    { value: 'agrocontrol', label: 'Агроконтроль (скоро)' },
];

export function kindLabel(kind) {
    return KIND_LABELS[kind] || '—';
}

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
    const canEditKinds = gpsCanEditKinds(app.context);
    const state = { provider: 'wialon', integrations: {}, integration: null, units: [], fleet: [], suggestions: new Map(), busy: false };
    let mapSection = null;
    const orgId = app.context && app.context.org_id;
    // Фільтри таблиці — окремо від вибору на карті (власний ключ у сховищі браузера), працюють на клієнті по вже завантаженому списку.
    const tstate = { filters: loadTableFilters(orgId), catalog: { groups: [], memberships: {} }, ready: false, shown: TABLE_PAGE };

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
            const out = await callApi(app, route, { provider: state.provider });
            button.disabled = false;
            if (!out.ok) {
                clear(message, notice(out.error || out.message || 'Не вдалося виконати дію.'));
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
                    toast('Юнітів: ' + out.counts.total + ' (нових ' + out.counts.added + ', неактивних ' + out.counts.deactivated + ')'
                        + (out.groups && out.groups.synced ? ', груп ' + out.groups.total : ''));
                    // Помилку груп не ховаємо: код і текст лишаються на екрані.
                    if (out.groups && out.groups.error) clear(message, notice(out.groups.message + ' (код: ' + out.groups.error + ')'));
                    await load(true);
                    // Групи, типи й юніти над картою й у фільтрах таблиці оновлюються без F5.
                    if (mapSection && mapSection.reloadCatalog) await mapSection.reloadCatalog();
                }),
                confirmButton('Відключити', 'Точно відключити? Токен буде видалено', async () => {
                    const out = await callApi(app, 'disconnect', { provider: state.provider });
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

    const providerBox = h('div', { class: 'gps-provider' });

    function drawProviderSwitch() {
        const select = h('select', { id: 'gps-provider', onchange: (event) => {
            state.provider = event.currentTarget.value;
            state.integration = state.integrations[state.provider] || null;
            drawStatus();
        } }, GPS_PROVIDERS.map((o) => h('option', { value: o.value, selected: o.value === state.provider }, o.label)));
        clear(providerBox, h('div', { class: 'field' }, h('label', { for: 'gps-provider' }, 'Провайдер GPS'), select));
    }

    // Агроконтроль: можна зберегти доступ, але підключення ще не налаштовано — тест чесно повертає «не налаштовано».
    function agroBlock(it) {
        const message = h('div', { 'aria-live': 'polite' });
        const stored = it && it.token_hint;
        const row = (label, value) => h('div', { class: 'gps-row' }, h('span', { class: 'muted' }, label), h('b', null, value));
        const token = h('input', { id: 'gps-agro-token', type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '512' });
        const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, stored ? 'Замінити токен' : 'Зберегти доступ');
        const form = access.canManage ? h('form', { class: 'form gps-agro-form', novalidate: true, onsubmit: async (event) => {
            event.preventDefault();
            let value = token.value.trim();
            token.value = '';
            if (value.length < 8 || /\s/.test(value)) {
                value = null;
                clear(message, notice('Токен має містити від 8 символів без пробілів.'));
                return;
            }
            submit.disabled = true;
            clear(message, spinner('Зберігаємо доступ…'));
            const body = { provider: 'agrocontrol', token: value };
            value = null;
            const out = await callApi(app, 'connect', body);
            body.token = null;
            submit.disabled = false;
            if (!out.ok) {
                clear(message, notice(out.error || out.message || 'Не вдалося зберегти доступ.'));
                return;
            }
            clear(message);
            toast('Доступ до Агроконтролю збережено');
            await load();
        } },
        h('div', { class: 'field' }, h('label', { for: 'gps-agro-token' }, 'Токен доступу Агроконтролю'), token,
            h('span', { class: 'hint' }, 'Зберігається зашифровано у сховищі секретів; тут показуємо лише останні 4 символи.')),
        h('div', { class: 'actions' }, submit)) : null;
        const actions = h('div', { class: 'actions' });
        if (stored && access.canManage) {
            actions.append(
                h('button', { type: 'button', class: 'btn', onclick: async (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    clear(message, spinner('Перевіряємо…'));
                    const out = await callApi(app, 'test', { provider: 'agrocontrol' });
                    button.disabled = false;
                    clear(message, notice(out.message || out.error || 'Не налаштовано.', out.ok === false || !out.ok ? 'info' : undefined));
                    await load();
                } }, 'Перевірити підключення'),
                confirmButton('Відключити', 'Точно відключити? Токен буде видалено', async () => {
                    const out = await callApi(app, 'disconnect', { provider: 'agrocontrol' });
                    if (!out.ok) clear(message, notice(out.error || 'Не вдалося відключити.'));
                    else {
                        toast('Доступ видалено');
                        await load();
                    }
                }));
        }
        return h('div', { class: 'card gps-card' },
            h('div', { class: 'page-head' }, h('h2', null, 'Агроконтроль'), h('span', { class: 'badge gps-badge gps-pending' }, 'Скоро')),
            notice('Інтеграцію з Агроконтролем ще не налаштовано: токен можна зберегти заздалегідь, перевірка поки поверне «не налаштовано». Карта й юніти Агроконтролю зʼявляться пізніше.', 'info'),
            stored ? h('div', { class: 'gps-rows' }, row('Токен', it.token_hint), row('Перевірено', minutesAgo(it.last_checked_at))) : null,
            it && it.last_error_code ? notice(gpsMessage(it.last_error_code) + ' (код: ' + it.last_error_code + ')', 'info') : null,
            message, actions, form);
    }

    function drawStatus() {
        if (!access.seesIntegration) {
            clear(statusBox);
            return;
        }
        drawProviderSwitch();
        const it = state.integration;
        if (state.provider === 'agrocontrol') {
            clear(statusBox, agroBlock(it));
            return;
        }
        // 'pending' без токена — лише слід невдалої спроби (ліміт перебору): показуємо форму, а не картку.
        if (!it || it.status === 'disabled' || (it.status === 'pending' && !it.token_hint)) {
            if (access.canManage) clear(statusBox, connectForm());
            else clear(statusBox, notice('GPS ще не підключено. Підключає директор компанії.', 'info'));
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

    // Тип юніта: усі бачать; «Директор» і «Менеджер» виправляють вручну (kind_manual = true, sync не перезапише).
    async function setKind(unitId, kind, inline) {
        const { error } = await app.supabase.rpc('gps_set_kind', { p_gps_vehicle: unitId, p_kind: kind || null });
        if (error) {
            clear(inline, h('span', { class: 'hint hint-error' }, errorText(error)));
            return false;
        }
        return true;
    }

    function kindCell(u) {
        if (!canEditKinds) return h('span', null, kindLabel(u.kind), u.kind_manual ? h('span', { class: 'tag' }, 'вручну') : null);
        const inline = h('div', { 'aria-live': 'polite' });
        const select = h('select', { 'aria-label': 'Тип юніта ' + u.name, onchange: async (event) => {
            clear(inline);
            event.currentTarget.disabled = true;
            if (await setKind(u.id, event.currentTarget.value, inline)) {
                toast(event.currentTarget.value ? 'Тип збережено вручну' : 'Ручний тип знято');
                await load(true);
                if (mapSection && mapSection.reloadCatalog) mapSection.reloadCatalog();
            } else event.currentTarget.disabled = false;
        } },
        h('option', { value: '' }, u.kind_manual ? '— зняти ручний тип —' : (u.kind ? kindLabel(u.kind) + ' (за назвою)' : 'Не визначено')),
        KIND_OPTIONS.filter((o) => o.value !== 'none').map((o) => h('option', { value: o.value, selected: u.kind_manual && o.value === u.kind }, o.label)));
        return h('div', null, select, u.kind_manual ? h('span', { class: 'tag' }, 'вручну') : null, inline);
    }

    // ---------- Фільтри таблиці «Юніти й авто» ----------
    const tGroupPick = multiPick({ label: 'Групи', onChange: (groupIds) => setTableFilters({ groupIds }) });
    const tKindPick = multiPick({ label: 'Тип', onChange: (kinds) => setTableFilters({ kinds }) });
    let searchTimer = null;
    const tSearch = h('input', { type: 'search', class: 'gps-unit-search gps-tsearch', placeholder: 'Юніт: назва або номер', 'aria-label': 'Пошук у таблиці за назвою юніта або номером авто',
        autocomplete: 'off', maxlength: '60', value: tstate.filters.q, oninput: () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => setTableFilters({ q: tSearch.value }), 200);
        } });
    const tLink = h('select', { class: 'gps-tlink', 'aria-label': 'Прив’язка до авто', onchange: () => setTableFilters({ link: tLink.value }) },
        LINK_OPTIONS.map((o) => h('option', { value: o.value }, o.value === 'all' ? 'Прив’язка: усі' : o.label)));
    const tCount = h('span', { class: 'muted small gps-tcount', 'aria-live': 'polite' });
    const tReset = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-act': 'treset', onclick: () => {
        clearTimeout(searchTimer);
        tstate.filters = emptyTableFilters();
        tSearch.value = '';
        persistTableFilters();
    } }, 'Скинути');
    const tBar = h('div', { class: 'gps-tfilter card', hidden: true },
        h('div', { class: 'gps-filter-row' }, tGroupPick.element, tSearch, tKindPick.element, tLink, h('div', { class: 'actions' }, tReset, tCount)));

    function drawTableFilters() {
        const f2 = tstate.filters;
        tGroupPick.draw(tstate.catalog.groups.map((g) => ({ value: g.id, label: g.name + ' (' + g.count + ')' })), f2.groupIds);
        tKindPick.draw(KIND_OPTIONS, f2.kinds);
        tLink.value = f2.link;
        tReset.disabled = !tableFiltersActive(f2);
    }
    function persistTableFilters() {
        tstate.shown = TABLE_PAGE;
        saveTableFilters(orgId, tstate.filters);
        drawTableFilters();
        drawUnits();
    }
    function setTableFilters(patch) {
        tstate.filters = { ...tstate.filters, ...patch };
        persistTableFilters();
    }
    // Каталог карти (групи, склад груп) прийшов або оновився: фільтри таблиці й варіанти списків перемальовуються; зниклі групи прибираємо.
    function onCatalog(catalog) {
        tstate.catalog = catalog;
        tstate.ready = true;
        const pruned = pruneTableFilters(tstate.filters, catalog);
        if (JSON.stringify(pruned) !== JSON.stringify(tstate.filters)) {
            tstate.filters = pruned;
            saveTableFilters(orgId, pruned);
        }
        drawTableFilters();
        if (state.units.length) drawUnits();
    }
    drawTableFilters();

    function drawUnits() {
        const { units, fleet, suggestions } = state;
        tBar.hidden = !units.length;
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
                if (mapSection && mapSection.reloadCatalog) mapSection.reloadCatalog();
            } }, 'Прийняти всі підказки (' + suggestions.size + ')')
            : null;
        const filtered = filterUnitRows(units, tstate.ready ? tstate.filters : { ...tstate.filters, groupIds: [] }, tstate.catalog.memberships);
        const visible = filtered.slice(0, tstate.shown);
        tCount.textContent = 'Показано ' + visible.length + ' з ' + units.length + (filtered.length > visible.length && filtered.length < units.length ? ' (знайдено ' + filtered.length + ')' : '');
        const more = filtered.length > visible.length
            ? h('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'more', onclick: () => { tstate.shown += TABLE_PAGE; drawUnits(); } },
                'Показати ще (' + Math.min(TABLE_PAGE, filtered.length - visible.length) + ')')
            : null;
        const rows = visible.map((u) => {
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
                        if (mapSection && mapSection.reloadCatalog) mapSection.reloadCatalog();
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
                h('td', null, kindCell(u)),
                h('td', { class: 'mono small' }, u.external_id));
        });
        clear(unitsBox,
            acceptAll ? h('div', { class: 'toolbar' }, acceptAll, h('span', { class: 'muted small' }, 'Підказки — за збігом назви юніта з номером авто. Без кнопки нічого не змінюється.')) : null,
            h('div', { class: 'table-wrap' }, h('table', { class: 'table gps-units' },
                h('thead', null, h('tr', null, h('th', null, 'Юніт Wialon'), h('th', null, 'Авто'), h('th', null, 'Тип'), h('th', null, 'ID'))),
                h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'muted empty' }, 'За вибраними умовами юнітів немає.'))))),
            more ? h('div', { class: 'toolbar' }, more) : null);
    }

    async function load(keepSuggestions) {
        if (!keepSuggestions) state.suggestions = new Map();
        const tasks = [app.supabase.rpc('gps_units')];
        tasks.push(access.seesIntegration
            ? app.supabase.from('gps_integrations').select(INTEGRATION_COLUMNS).in('provider', GPS_PROVIDERS.map((o) => o.value))
            : Promise.resolve({ data: [], error: null }));
        tasks.push(app.supabase.from('gps_vehicles').select('id, kind, kind_manual').limit(5000));
        tasks.push(access.canManage
            ? app.supabase.from('fleet_vehicles').select('id, label').order('label', { ascending: true }).limit(1000)
            : Promise.resolve({ data: [], error: null }));
        const [units, integration, kinds, fleet] = await Promise.all(tasks);
        const error = units.error || integration.error || kinds.error || fleet.error;
        if (error) {
            if (isPlanError(error)) return app.onPlanLost();
            clear(unitsBox, notice(errorText(error)));
            return;
        }
        const kindOf = new Map((kinds.data || []).map((k) => [k.id, k]));
        state.units = (units.data || []).map((u) => ({ ...u, kind: (kindOf.get(u.id) || {}).kind || null, kind_manual: Boolean((kindOf.get(u.id) || {}).kind_manual) }));
        state.integrations = Object.fromEntries((integration.data || []).map((i) => [i.provider, i]));
        state.integration = state.integrations[state.provider] || null;
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

    // Карта (етап 2c) — для всіх ролей організації на control_plus; owner «До форми підключення» веде до форми нижче.
    const map = renderGpsMap(app, { onConnect: () => statusBox.scrollIntoView({ behavior: 'smooth', block: 'start' }), onCatalog });
    mapSection = map;

    return h('section', { class: 'page gps-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'GPS')),
        access.canManage ? null : notice(access.seesIntegration
            ? 'Режим перегляду: підключенням і привʼязкою авто керує директор компанії.'
            : 'Режим перегляду: юніти GPS і привʼязка до авто вашої компанії.', 'info'),
        map,
        access.seesIntegration ? h('h2', { class: 'section-title' }, access.canManage ? 'Підключення' : 'Підключення (перегляд)') : null,
        providerBox,
        statusBox,
        h('h2', { class: 'section-title' }, 'Юніти й авто'),
        tBar,
        unitsBox);
}
