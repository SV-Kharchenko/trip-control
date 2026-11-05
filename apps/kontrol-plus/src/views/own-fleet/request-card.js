// «Власний парк»: форма нової заявки і картка заявки (вікно поверх дошки на ≥900px, сторінка на вужчих). Усі зміни статусу — лише
// RPC fleet_request_* (права й дозволені переходи перевіряє БД; кнопки тут — підказка інтерфейсу за nextActions()).
import { h, clear, notice, spinner, toast, uniqueId } from '../../ui.js';
import {
    PRIORITIES, PRIORITY_LABELS, STATUS_LABELS, fmtWhen, fromLocalInput, isOverdue, nextActions, ownFleetErrorText, routeText, toLocalInput,
} from '../../lib/own-fleet.js';
import { loadAll, loadResources, nameOf } from './data.js';

const changed = () => window.dispatchEvent(new CustomEvent('kp:registry-changed'));

function field(label, control, id) {
    return h('div', { class: 'field' }, h('label', { for: id }, label), control);
}

// Нова заявка: замовник — лише свої підрозділи; персонал — будь-який активний.
export function renderRequestForm(app, access) {
    const root = h('div', { class: 'kpof-form' }, spinner());
    (async () => {
        const data = await loadAll(app);
        if (data.error) { clear(root, notice(ownFleetErrorText(data.error))); return; }
        const units = data.units.filter((u) => !u.archived && (!access.isRequester || access.unitIds.includes(u.id)));
        if (!units.length) {
            clear(root, h('h2', null, 'Нова заявка'), notice(access.isRequester ? 'Вас ще не додано до жодного підрозділу. Зверніться до директора компанії.' : 'Спершу додайте підрозділ.', 'info'));
            return;
        }
        const points = data.points.filter((p) => !p.archived);
        const id = (k) => uniqueId('kpof-' + k);
        const ids = { unit: id('unit'), cargo: id('cargo'), qty: id('qty'), from: id('from'), to: id('to'), when: id('when'), dur: id('dur'), prio: id('prio'), note: id('note') };
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
        tomorrow.setMinutes(0, 0, 0);
        const unit = h('select', { id: ids.unit, required: true }, units.map((u) => h('option', { value: u.id }, u.name)));
        const cargo = h('input', { id: ids.cargo, type: 'text', maxlength: 200, required: true, placeholder: 'напр. пшениця 3 кл.', autocomplete: 'off' });
        const qty = h('input', { id: ids.qty, type: 'text', inputmode: 'decimal', placeholder: 'т', autocomplete: 'off' });
        const pointSel = (selId, label) => h('select', { id: selId, 'aria-label': label },
            h('option', { value: '' }, '— вручну —'), points.map((p) => h('option', { value: p.id }, p.name)));
        const fromSel = pointSel(ids.from, 'Звідки: точка');
        const toSel = pointSel(ids.to, 'Куди: точка');
        const fromText = h('input', { type: 'text', maxlength: 200, placeholder: 'Звідки (текст)', 'aria-label': 'Звідки: текст', autocomplete: 'off' });
        const toText = h('input', { type: 'text', maxlength: 200, placeholder: 'Куди (текст)', 'aria-label': 'Куди: текст', autocomplete: 'off' });
        const when = h('input', { id: ids.when, type: 'datetime-local', required: true, value: toLocalInput(tomorrow.toISOString()) });
        const dur = h('input', { id: ids.dur, type: 'text', inputmode: 'decimal', value: '8', autocomplete: 'off' });
        const prio = h('select', { id: ids.prio }, PRIORITIES.map((p) => h('option', { value: p }, PRIORITY_LABELS[p])));
        const note = h('textarea', { id: ids.note, rows: 2, maxlength: 1000 });
        const message = h('div', { 'aria-live': 'polite' });
        const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Створити заявку');
        const num = (v) => { const t = String(v).trim().replace(',', '.'); return t === '' ? null : Number(t); };
        const form = h('form', { class: 'form', novalidate: true, onsubmit: async (event) => {
            event.preventDefault();
            clear(message);
            const iso = fromLocalInput(when.value);
            const q = num(qty.value);
            const d = num(dur.value);
            if (!cargo.value.trim()) return clear(message, notice('Вкажіть вантаж.'));
            if (!iso) return clear(message, notice('Вкажіть бажаний час.'));
            if ((q !== null && !(q > 0)) || (d !== null && !(d > 0))) return clear(message, notice('Обсяг і тривалість мають бути додатними числами.'));
            if (!fromSel.value && !fromText.value.trim()) return clear(message, notice('Вкажіть, звідки забрати вантаж.'));
            if (!toSel.value && !toText.value.trim()) return clear(message, notice('Вкажіть, куди доставити.'));
            submit.disabled = true;
            const { error } = await app.supabase.rpc('fleet_request_create', {
                p_unit: unit.value, p_cargo: cargo.value.trim(), p_qty_t: q, p_from_point: fromSel.value || null, p_to_point: toSel.value || null,
                p_from_text: fromSel.value ? null : fromText.value, p_to_text: toSel.value ? null : toText.value, p_wanted_at: iso,
                p_priority: prio.value, p_note: note.value, p_duration_h: d === null ? 8 : d,
            });
            submit.disabled = false;
            if (error) return clear(message, notice(ownFleetErrorText(error)));
            toast('Заявку створено');
            if (typeof app.closeWindow === 'function') app.closeWindow(true);
            else app.go('#/own-fleet');
        } },
        field('Підрозділ', unit, ids.unit), field('Вантаж', cargo, ids.cargo), field('Обсяг, т', qty, ids.qty),
        h('div', { class: 'field kpof-pair' }, h('label', { for: ids.from }, 'Звідки'), fromSel, fromText),
        h('div', { class: 'field kpof-pair' }, h('label', { for: ids.to }, 'Куди'), toSel, toText),
        field('Бажаний час подачі', when, ids.when), field('Орієнтовна тривалість, год', dur, ids.dur), field('Пріоритет', prio, ids.prio),
        field('Примітка', note, ids.note), message,
        h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'btn', onclick: () => (typeof app.closeWindow === 'function' ? app.closeWindow(false) : app.go('#/own-fleet')) }, 'Скасувати')));
        clear(root, h('h2', null, 'Нова заявка'), form);
    })();
    return root;
}

function dl(rows) {
    return h('dl', { class: 'kpof-dl' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

export function renderRequestCard(app, access, id) {
    const root = h('div', { class: 'kpof-card-view' }, spinner());
    const userId = app.user && app.user.id;
    let data = null;
    let resources = null;

    async function load() {
        const [all, log] = await Promise.all([
            loadAll(app),
            app.supabase.from('fleet_request_log').select('*').eq('request_id', id).order('id', { ascending: true }),
        ]);
        if (all.error) { clear(root, notice(ownFleetErrorText(all.error))); return; }
        const request = all.requests.find((r) => r.id === id);
        if (!request) { clear(root, h('h2', null, 'Заявка'), notice('Заявку не знайдено або вона вам недоступна.', 'info')); return; }
        data = { ...all, request, log: log.data || [] };
        paint();
    }

    async function act(to, reason) {
        const { error } = await app.supabase.rpc('fleet_request_transition', { p_id: id, p_to: to, p_reason: reason || null });
        if (error) { toast(ownFleetErrorText(error), 'error'); return false; }
        toast('Статус: ' + STATUS_LABELS[to]);
        changed();
        await load();
        return true;
    }

    function cancelPanel(slot, onDone) {
        const reason = h('textarea', { rows: 2, maxlength: 500, 'aria-label': 'Причина скасування', placeholder: 'Причина скасування (обовʼязково)' });
        const msg = h('div', { 'aria-live': 'polite' });
        clear(slot, h('div', { class: 'kpof-panel' }, reason, msg, h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn btn-danger', onclick: async () => {
                if (!reason.value.trim()) return clear(msg, notice('Вкажіть причину скасування.'));
                if (!(await act('cancelled', reason.value.trim()))) onDone();
            } }, 'Скасувати заявку'),
            h('button', { type: 'button', class: 'btn', onclick: onDone }, 'Не скасовувати'))));
    }

    async function assignPanel(slot) {
        clear(slot, spinner());
        if (!resources) resources = await loadResources(app);
        if (resources.error) { clear(slot, notice(ownFleetErrorText(resources.error))); return; }
        const r = data.request;
        const opt = (list, empty, cur) => [h('option', { value: '' }, empty)].concat(list.map((x) => h('option', { value: x.id, selected: x.id === cur }, x.label)));
        const veh = h('select', { 'aria-label': 'Авто' }, opt(resources.vehicles, '— оберіть авто —', r.vehicle_id));
        const trl = h('select', { 'aria-label': 'Причіп' }, opt(resources.trailers, '— без причепа —', r.trailer_id));
        const drv = h('select', { 'aria-label': 'Водій' }, opt(resources.drivers, '— оберіть водія —', r.driver_id));
        const warn = h('div', { 'aria-live': 'polite' });
        const check = async () => {
            clear(warn);
            if (!veh.value && !drv.value) return;
            const { data: rows } = await app.supabase.rpc('fleet_request_conflicts', { p_id: id, p_vehicle: veh.value || null, p_driver: drv.value || null });
            if (rows && rows.length) {
                clear(warn, notice('Увага, перетин у часі: ' + rows.map((c) => (c.kind === 'vehicle' ? 'авто' : 'водій') + ' уже в заявці № ' + c.number + ' (' + fmtWhen(c.wanted_at) + ')').join('; ')
                    + '. Призначення можливе, але перевірте графік.', 'info'));
            }
        };
        veh.addEventListener('change', check);
        drv.addEventListener('change', check);
        const msg = h('div', { 'aria-live': 'polite' });
        clear(slot, h('div', { class: 'kpof-panel' }, field('Авто', veh), field('Причіп', trl), field('Водій', drv), warn, msg, h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
                if (!veh.value || !drv.value) return clear(msg, notice('Оберіть авто та водія.'));
                const { data: out, error } = await app.supabase.rpc('fleet_request_assign', { p_id: id, p_vehicle: veh.value, p_trailer: trl.value || null, p_driver: drv.value });
                if (error) return clear(msg, notice(ownFleetErrorText(error)));
                toast(out && out.conflicts && out.conflicts.length ? 'Призначено (є перетини у часі)' : 'Призначено');
                changed();
                await load();
            } }, 'Призначити'),
            h('button', { type: 'button', class: 'btn', onclick: () => paint() }, 'Закрити'))));
        check();
    }

    function paint() {
        const r = data.request;
        const actions = nextActions(r, access.role, userId);
        const slot = h('div', { class: 'kpof-slot' });
        const buttons = actions.map((a) => h('button', { type: 'button', class: 'btn ' + (a.danger ? 'btn-danger' : a.assign ? '' : 'btn-primary'), 'data-act': a.to + (a.assign ? '-assign' : ''),
            onclick: () => {
                if (a.needsReason) cancelPanel(slot, () => clear(slot));
                else if (a.assign) assignPanel(slot);
                else act(a.to);
            } }, a.label));
        const logRows = data.log.map((l) => h('li', null, h('span', { class: 'mono small' }, fmtWhen(l.at)), ' ', l.from_status ? STATUS_LABELS[l.from_status] + ' → ' : '', h('b', null, STATUS_LABELS[l.to_status]),
            l.note ? h('span', { class: 'muted' }, ' — ' + l.note) : null));
        clear(root,
            h('div', { class: 'kpof-card-head' }, h('h2', null, 'Заявка № ' + r.number), h('span', { class: 'kpof-badge kpof-st-' + r.status }, STATUS_LABELS[r.status]),
                r.priority !== 'normal' ? h('span', { class: 'kpof-badge kpof-prio-' + r.priority }, PRIORITY_LABELS[r.priority]) : null,
                isOverdue(r) ? h('span', { class: 'kpof-badge kpof-late' }, 'Прострочена') : null),
            dl([
                ['Підрозділ', nameOf(data.units, r.unit_id)],
                ['Вантаж', r.cargo + (r.qty_t ? ' · ' + String(r.qty_t).replace('.', ',') + ' т' : '')],
                ['Маршрут', routeText(r, data.points)],
                ['Бажаний час', fmtWhen(r.wanted_at) + ' · ~' + String(r.duration_h).replace('.', ',') + ' год'],
                r.note ? ['Примітка', r.note] : null,
                r.vehicle_label ? ['Авто', r.vehicle_label + (r.trailer_label ? ' + причіп ' + r.trailer_label : '')] : null,
                r.driver_name ? ['Водій', r.driver_name] : null,
                r.cancel_reason ? ['Причина скасування', r.cancel_reason] : null,
            ]),
            buttons.length ? h('div', { class: 'actions kpof-actions-row' }, buttons) : null,
            slot,
            // Рейс / подорожній: зараз лише посилання (fleet_request_set_trip). TODO наступного етапу: передзаповнити подорожній лист
            // (авто, водій, маршрут) з заявки, не змінюючи наявну форму подорожнього листа.
            access.canManage && ['assigned', 'in_progress', 'done'].includes(r.status)
                ? h('p', { class: 'small' }, r.trip_id ? h('a', { href: '#/docs/trip_sheet/' + r.trip_id }, 'Відкрити подорожній лист')
                    : [h('a', { class: 'btn btn-sm', href: '#/docs/new/trip_sheet' }, 'Створити подорожній лист'), h('span', { class: 'muted' }, ' авто, водія й маршрут внесіть у формі вручну')]) : null,
            h('h3', { class: 'kpc-section' }, 'Історія'), h('ul', { class: 'kpof-log' }, logRows));
    }

    load();
    return root;
}
