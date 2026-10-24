// «Відповідальні» (лише власник і директор): призначені логісти й менеджери з ремонтів, запрошення менеджера
// за посиланням (до 2 місць разом з чинними запрошеннями). Посилання бачить лише той, хто запрошує, і лише коли лист
// не надіслано (немає Resend у проєкті).
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { callKpApi } from '../lib/gps-client.js';
import { repairErrorText, INVITE_STATUS_LABELS, seatsText, REPAIR_ROLE_LABELS } from '../lib/repairs.js';

function invitesApi(app, body) {
    return callKpApi(app, '/api/repairs/invites', body);
}

export function renderHandlers(app) {
    const handlersBox = h('div', { class: 'list' }, spinner());
    const invitesBox = h('div', { class: 'list' }, spinner());
    const seats = h('p', { class: 'muted small', 'aria-live': 'polite' });
    const message = h('div', { 'aria-live': 'polite' });
    const linkBox = h('div', { 'aria-live': 'polite' });
    const candidate = h('select', { id: 'kpr-h-logist', 'aria-label': 'Логіст' }, h('option', { value: '' }, '— активний логіст —'));
    const email = h('input', { id: 'kpr-h-email', type: 'email', autocomplete: 'off', maxlength: '254', placeholder: 'пошта менеджера з ремонтів' });

    const fail = (text) => clear(message, notice(text));

    function showLink(out) {
        if (out.mail_sent) {
            clear(linkBox, notice('Лист із запрошенням надіслано на ' + out.invite.email + '.', 'info'));
            return;
        }
        const input = h('input', { type: 'text', readonly: true, value: out.link, class: 'mono', 'aria-label': 'Посилання-запрошення' });
        clear(linkBox, h('div', { class: 'notice notice-info' },
            h('p', null, 'Пошту для запрошень не налаштовано — передайте посилання менеджеру самі (діє 7 днів):'),
            h('div', { class: 'toolbar' }, input, h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => {
                try {
                    await navigator.clipboard.writeText(out.link);
                    toast('Посилання скопійовано');
                } catch {
                    input.select();
                }
            } }, 'Скопіювати посилання'))));
    }

    async function loadHandlers() {
        const [list, cands] = await Promise.all([app.supabase.rpc('kp_repair_handlers_list'), app.supabase.rpc('kp_repair_logist_candidates')]);
        if (list.error) return clear(handlersBox, notice(repairErrorText(list.error)));
        clear(candidate, h('option', { value: '' }, '— активний логіст —'), (cands.data || []).map((c) => h('option', { value: c.user_id }, c.email)));
        const rows = list.data || [];
        clear(handlersBox, rows.length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Хто', 'Роль', 'Пошта', 'З', ''].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((r) => h('tr', null,
                h('td', { 'data-label': 'Хто' }, r.name || '—'),
                h('td', { 'data-label': 'Роль' }, REPAIR_ROLE_LABELS[r.kind] || r.kind),
                h('td', { 'data-label': 'Пошта' }, r.email || '—'),
                h('td', { 'data-label': 'З' }, fmtDate(r.created_at)),
                h('td', { 'data-label': '' }, confirmButton('Прибрати', 'Точно прибрати?', async () => {
                    const { error } = await app.supabase.rpc('kp_repair_handler_remove', { p_user: r.user_id });
                    if (error) fail(repairErrorText(error));
                    else {
                        toast('Прибрано');
                        await Promise.all([loadHandlers(), loadInvites()]);
                    }
                }, 'btn btn-sm btn-danger'))))))) : h('p', { class: 'muted' }, 'Відповідальних ще немає. Власник і директор вносять ремонти завжди.'));
    }

    async function loadInvites() {
        const out = await invitesApi(app, { action: 'list' });
        if (!out.ok) {
            clear(invitesBox, notice(out.error));
            seats.textContent = '';
            return;
        }
        seats.textContent = seatsText(out.seats);
        const rows = out.invites || [];
        clear(invitesBox, rows.length ? h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Пошта', 'Статус', 'Діє до', ''].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((i) => h('tr', { class: i.status === 'sent' ? '' : 'is-archived' },
                h('td', { 'data-label': 'Пошта' }, i.email),
                h('td', { 'data-label': 'Статус' }, h('span', { class: 'tag kpr-invite-' + i.status }, INVITE_STATUS_LABELS[i.status] || i.status)),
                h('td', { 'data-label': 'Діє до' }, fmtDate(i.expires_at)),
                h('td', { 'data-label': '' }, i.status === 'sent' || i.status === 'expired' ? h('div', { class: 'actions' },
                    h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => {
                        const res = await invitesApi(app, { action: 'resend', id: i.id });
                        if (!res.ok) return fail(res.error);
                        showLink(res);
                        await loadInvites();
                    } }, 'Надіслати ще раз'),
                    i.status === 'sent' ? confirmButton('Скасувати', 'Точно скасувати?', async () => {
                        const res = await invitesApi(app, { action: 'revoke', id: i.id });
                        if (!res.ok) return fail(res.error);
                        toast('Запрошення скасовано');
                        await loadInvites();
                    }, 'btn btn-sm btn-danger') : null) : null)))))) : h('p', { class: 'muted' }, 'Запрошень ще не було.'));
    }

    loadHandlers();
    loadInvites();

    return h('div', null,
        message,
        h('h2', { class: 'section-title' }, 'Відповідальні за ремонти'),
        h('div', { class: 'toolbar' }, candidate, h('button', { type: 'button', class: 'btn', onclick: async () => {
            if (!candidate.value) return fail('Оберіть логіста.');
            const { error } = await app.supabase.rpc('kp_repair_handler_add', { p_user: candidate.value, p_kind: 'logist' });
            if (error) fail(repairErrorText(error));
            else {
                clear(message);
                toast('Логіста призначено');
                await loadHandlers();
            }
        } }, 'Призначити логіста')),
        handlersBox,
        h('h2', { class: 'section-title' }, 'Менеджери з ремонтів'),
        h('p', { class: 'muted small' }, 'Менеджер з ремонтів — людина поза командою (не займає місця логіста): бачить лише «Ремонти і склад» вашої компанії. '
            + 'До 2 менеджерів; запрошення, що очікує, теж займає місце.'),
        seats,
        h('form', { class: 'toolbar', onsubmit: async (e) => {
            e.preventDefault();
            const out = await invitesApi(app, { action: 'create', email: email.value });
            if (!out.ok) return fail(out.error);
            clear(message);
            email.value = '';
            showLink(out);
            await loadInvites();
        } }, email, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Запросити менеджера з ремонтів')),
        linkBox,
        invitesBox);
}
