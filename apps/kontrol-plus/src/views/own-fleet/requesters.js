// «Власний парк»: блок «Замовники підрозділів» у вкладці «Команда» кабінету (лише директор й менеджер, лише в організації з own_fleet).
// Список замовників (ПІБ / пошта, підрозділи), відкриті запрошення (статус, повторити, скасувати), «Запросити», «Змінити підрозділи»,
// «Прибрати». Дані — RPC own_fleet_requesters_list / own_fleet_requester_set_units / own_fleet_requester_remove і API /api/own-fleet/invites.
import { h, clear, notice, spinner, toast, confirmButton, uniqueId } from '../../ui.js';
import { ownFleetErrorText } from '../../lib/own-fleet.js';
import { callKpApi } from '../../lib/gps-client.js';

const INVITES = '/api/own-fleet/invites';
const STATUS_TEXT = { sent: 'очікує відповіді', expired: 'строк минув', revoked: 'скасовано' };

function chips(unitIds, units) {
    const names = (unitIds || []).map((id) => (units.find((u) => u.id === id) || {}).name).filter(Boolean);
    return h('span', { class: 'kpof-chips' }, names.length ? names.map((n) => h('span', { class: 'kpof-chip' }, n)) : h('span', { class: 'muted small' }, 'без підрозділів'));
}

function unitChecks(units, selected, name) {
    return h('div', { class: 'kpof-checks', role: 'group', 'aria-label': 'Підрозділи' }, units.map((u) => {
        const id = uniqueId('kpof-chk');
        return h('label', { class: 'kpof-check', for: id }, h('input', { type: 'checkbox', id, name, value: u.id, checked: selected.includes(u.id) }), ' ', u.name);
    }));
}

const picked = (box) => [...box.querySelectorAll('input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.value);

// app: { supabase, ownFleet }. Права: owner / director (UI-підказка; БД та API перевіряють самі).
export function renderRequestersBlock(app) {
    const role = app.ownFleet && app.ownFleet.role;
    if (role !== 'owner' && role !== 'director') return h('div', { hidden: true });
    const root = h('section', { class: 'kpof kpof-team cab-card', 'aria-label': 'Замовники підрозділів' }, spinner());
    const message = h('div', { 'aria-live': 'polite' });
    let editing = null;

    async function load() {
        const [unitsRes, listRes, invitesRes] = await Promise.all([
            app.supabase.from('org_units').select('id, name, archived').order('name', { ascending: true }),
            app.supabase.rpc('own_fleet_requesters_list'),
            callKpApi({ supabase: app.supabase }, INVITES, { action: 'list' }),
        ]);
        const error = unitsRes.error || listRes.error;
        if (error) { clear(root, notice(ownFleetErrorText(error))); return; }
        paint(unitsRes.data || [], listRes.data || [], (invitesRes && invitesRes.invites) || []);
    }

    function report(out, okText) {
        if (!out.ok) { clear(message, notice(out.error || 'Не вдалося виконати дію.')); return false; }
        clear(message, out.mail_sent === false && out.link
            ? h('div', { class: 'notice notice-info' }, 'Лист не надіслано (пошта не налаштована). Скопіюйте посилання й передайте замовнику: ', h('code', { class: 'kpof-link' }, out.link))
            : notice(okText, 'info'));
        return true;
    }

    function paint(allUnits, requesters, invites) {
        const units = allUnits.filter((u) => !u.archived);
        const pending = invites.filter((i) => i.status !== 'accepted');
        const requesterRow = (r) => {
            const slot = h('div', { class: 'kpof-slot' });
            const label = r.full_name ? r.full_name + ' · ' + r.email : r.email;
            if (editing === r.user_id) {
                const box = unitChecks(units, r.unit_ids, 'units-' + r.user_id);
                clear(slot, h('div', { class: 'kpof-panel' }, box, h('div', { class: 'actions' },
                    h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'save-units', onclick: async () => {
                        const { error } = await app.supabase.rpc('own_fleet_requester_set_units', { p_user: r.user_id, p_unit_ids: picked(box) });
                        if (error) return clear(message, notice(ownFleetErrorText(error)));
                        editing = null;
                        toast('Підрозділи замовника збережено');
                        load();
                    } }, 'Зберегти'),
                    h('button', { type: 'button', class: 'btn', onclick: () => { editing = null; load(); } }, 'Скасувати'))));
            }
            return h('li', { class: 'kpof-req', 'data-user': r.user_id },
                h('div', { class: 'kpof-req-main' }, h('b', null, label), chips(r.unit_ids, allUnits)),
                h('div', { class: 'actions' },
                    h('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'edit-units', onclick: () => { editing = r.user_id; load(); } }, 'Змінити підрозділи'),
                    confirmButton('Прибрати', 'Точно прибрати замовника?', async () => {
                        const { error } = await app.supabase.rpc('own_fleet_requester_remove', { p_user: r.user_id });
                        if (error) return clear(message, notice(ownFleetErrorText(error)));
                        toast('Замовника прибрано');
                        load();
                    }, 'btn btn-sm btn-danger')),
                slot);
        };
        const inviteRow = (i) => h('li', { class: 'kpof-req', 'data-invite': i.id },
            h('div', { class: 'kpof-req-main' }, h('b', null, i.email), h('span', { class: 'muted small' }, ' — ' + (STATUS_TEXT[i.status] || i.status)), chips(i.unit_ids, allUnits)),
            h('div', { class: 'actions' },
                h('button', { type: 'button', class: 'btn btn-sm', 'data-act': 'resend', onclick: async () => { if (report(await callKpApi({ supabase: app.supabase }, INVITES, { action: 'resend', id: i.id }), 'Запрошення надіслано ще раз.')) load(); } }, 'Повторити'),
                i.status === 'sent' ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-act': 'revoke', onclick: async () => { if (report(await callKpApi({ supabase: app.supabase }, INVITES, { action: 'revoke', id: i.id }), 'Запрошення скасовано.')) load(); } }, 'Скасувати') : null));

        const email = h('input', { type: 'email', maxlength: 254, placeholder: 'пошта замовника', 'aria-label': 'Пошта замовника', autocomplete: 'off' });
        const inviteUnits = unitChecks(units, [], 'invite-units');
        const invite = h('div', { class: 'kpof-panel kpof-invite' },
            h('div', { class: 'kpof-invite-row' }, email),
            units.length ? inviteUnits : h('p', { class: 'muted small' }, 'Спершу додайте підрозділ (Власний парк → Підрозділи).'),
            h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'invite', disabled: !units.length, onclick: async () => {
                clear(message);
                if (!email.value.trim()) return clear(message, notice('Вкажіть пошту.'));
                const ids = picked(inviteUnits);
                if (!ids.length) return clear(message, notice('Оберіть хоча б один підрозділ.'));
                if (report(await callKpApi({ supabase: app.supabase }, INVITES, { action: 'create', email: email.value.trim(), unit_ids: ids }), 'Запрошення надіслано.')) load();
            } }, 'Запросити')));

        clear(root,
            h('div', { class: 'cab-card-head' }, h('h3', null, 'Замовники підрозділів')),
            h('p', { class: 'muted small' }, 'Замовник бачить і створює заявки на рейс лише свого підрозділу; фінанси, клієнти, документи й автопарк йому недоступні. Місця логістів не займає.'),
            requesters.length ? h('ul', { class: 'kpof-reqs' }, requesters.map(requesterRow)) : h('p', { class: 'muted' }, 'Замовників ще немає.'),
            pending.length ? [h('h4', { class: 'kpof-sub-h' }, 'Запрошення'), h('ul', { class: 'kpof-reqs' }, pending.map(inviteRow))] : null,
            h('h4', { class: 'kpof-sub-h' }, 'Запросити замовника'), invite, message);
    }

    load();
    return root;
}
