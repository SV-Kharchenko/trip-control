// Заявка без клієнта: привʼязка клієнта до заявки перед створенням документа (ТТН, акт, рахунок, подорожній лист).
import { h, clear, notice } from '../ui.js';
import { errorText } from '../lib/errors.js';

// Прив'язка клієнта до заявки тим самим шляхом, що в client-card.js (insert у calculation_clients, guard kp_calculation_clients_guard / kp_can_link).
// Повертає null при успіху або текст помилки.
export async function linkCalcClient(app, calcId, clientId) {
    try {
        const { error } = await app.supabase.from('calculation_clients').insert({ calculation_id: calcId, client_id: clientId });
        if (!error) return null;
        if (/CLIENT_LINK_FORBIDDEN/.test(String(error.message || ''))) return 'Немає права привʼязувати рейси, зверніться до власника.';
        return errorText(error);
    } catch (error) {
        return errorText(error);
    }
}

// Заявка без клієнта: сервер створює документи з заявки лише для привʼязаного клієнта, тому форма спершу просить його обрати.
// Спільний блок для ТТН, акта, рахунку й подорожнього листа. onLinked(clientId) відкриває звичайну заповнену форму.
export function linkClientPanel(app, { kind, calcId, onLinked }) {
    const message = h('div', { 'aria-live': 'polite' });
    const select = h('select', { id: 'kpd-link-client', 'aria-label': 'Клієнт заявки', disabled: true }, h('option', { value: '' }, '— завантажуємо клієнтів —'));
    const button = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, 'Привʼязати і продовжити');
    (async () => {
        let rows = [];
        try {
            const res = await app.supabase.from('clients').select('id, name, archived_at').order('name', { ascending: true }).limit(2000);
            rows = res.error ? [] : (res.data || []).filter((c) => !c.archived_at);
        } catch {
            rows = [];
        }
        clear(select, h('option', { value: '' }, rows.length ? '— оберіть клієнта —' : '— клієнтів немає —'), rows.map((c) => h('option', { value: c.id }, c.name)));
        select.disabled = !rows.length;
        button.disabled = !rows.length;
    })();
    button.addEventListener('click', async () => {
        clear(message);
        if (!select.value) return clear(message, notice('Оберіть клієнта.'));
        button.disabled = true;
        const failure = await linkCalcClient(app, calcId, select.value);
        if (failure) {
            button.disabled = false;
            return clear(message, notice(failure));
        }
        onLinked(select.value);
    });
    return h('div', { class: 'card kpd-link-client' },
        notice('У заявці не вказано клієнта. Оберіть клієнта — його буде привʼязано до заявки.', 'info'),
        h('div', { class: 'field' }, h('label', { for: 'kpd-link-client' }, 'Клієнт'), select),
        message,
        h('div', { class: 'actions' }, button, h('a', { class: 'btn btn-ghost', href: '#/docs/new/' + kind }, 'Створити без заявки')));
}
