// «Власний парк»: підрозділи й точки — списки та картки (вікно поверх списку на ≥900px, сторінка на вужчих). CRUD для owner / director /
// logist через RLS (org_units, org_points); запрошення замовників — API /api/own-fleet/invites.
import { h, clear, notice, spinner, toast, uniqueId } from '../../ui.js';
import { POINT_KINDS, UNIT_KINDS, ownFleetErrorText } from '../../lib/own-fleet.js';
import { callKpApi } from '../../lib/gps-client.js';
import { loadAll, nameOf, onRegistryChanged } from './data.js';

const changed = () => window.dispatchEvent(new CustomEvent('kp:registry-changed'));
const kindOptions = (kinds, cur) => Object.entries(kinds).map(([v, l]) => h('option', { value: v, selected: v === cur }, l));

function row(label, control, id) {
    return h('div', { class: 'field kpc-row' }, h('label', { for: id }, label), h('span', { class: 'kpc-box kpc-w-xl' }, control));
}
const numOrNull = (v) => { const t = String(v).trim().replace(',', '.'); return t === '' ? null : Number(t); };

function listPage(root, { title, addHref, addLabel, rows, columns, empty }) {
    clear(root,
        h('div', { class: 'kpof-head' }, h('h2', { class: 'kpof-title' }, title), h('div', { class: 'kpof-actions' }, h('a', { class: 'btn btn-primary', href: addHref }, addLabel))),
        rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table kpof-table' },
            h('thead', null, h('tr', null, columns.map((c) => h('th', null, c.label)))),
            h('tbody', null, rows.map((r) => h('tr', { class: r.archived ? 'kpof-archived' : '' }, columns.map((c) => h('td', { 'data-label': c.label }, c.cell(r)))))))) : h('p', { class: 'muted' }, empty));
}

export function renderUnitsList(app) {
    const root = h('div', null, spinner());
    async function load() {
        const data = await loadAll(app);
        if (data.error) { clear(root, notice(ownFleetErrorText(data.error))); return; }
        const members = await app.supabase.from('org_unit_members').select('unit_id');
        const count = (id) => (members.data || []).filter((m) => m.unit_id === id).length;
        listPage(root, {
            title: 'Підрозділи', addHref: '#/own-fleet/unit/new', addLabel: '+ Підрозділ', rows: data.units, empty: 'Підрозділів ще немає. Додайте перший.',
            columns: [
                { label: 'Назва', cell: (u) => h('a', { href: '#/own-fleet/unit/' + u.id }, u.name) },
                { label: 'Тип', cell: (u) => UNIT_KINDS[u.kind] },
                { label: 'Центр витрат', cell: (u) => u.cost_center || '—' },
                { label: 'Замовників', cell: (u) => String(count(u.id)) },
                { label: 'Статус', cell: (u) => (u.archived ? 'в архіві' : 'активний') },
            ],
        });
    }
    onRegistryChanged(app, load);
    load();
    return root;
}

export function renderPointsList(app) {
    const root = h('div', null, spinner());
    async function load() {
        const data = await loadAll(app);
        if (data.error) { clear(root, notice(ownFleetErrorText(data.error))); return; }
        listPage(root, {
            title: 'Поля й точки', addHref: '#/own-fleet/point/new', addLabel: '+ Точка', rows: data.points, empty: 'Точок ще немає. Додайте перше поле, елеватор чи склад.',
            columns: [
                { label: 'Назва', cell: (p) => h('a', { href: '#/own-fleet/point/' + p.id }, p.name) },
                { label: 'Тип', cell: (p) => POINT_KINDS[p.kind] },
                { label: 'Підрозділ', cell: (p) => (p.unit_id ? nameOf(data.units, p.unit_id) : 'спільна') },
                { label: 'Культура', cell: (p) => p.crop || '—' },
                { label: 'Площа, га', cell: (p) => (p.area_ha === null || p.area_ha === undefined ? '—' : String(p.area_ha).replace('.', ',')) },
                { label: 'Координати', cell: (p) => (p.lat === null || p.lat === undefined ? '—' : Number(p.lat).toFixed(4) + ', ' + Number(p.lng).toFixed(4)) },
            ],
        });
    }
    onRegistryChanged(app, load);
    load();
    return root;
}

function closeCard(app, didChange) {
    if (typeof app.closeWindow === 'function') app.closeWindow(didChange);
    else { if (didChange) changed(); app.go('#/own-fleet/units'); }
}

// Картка підрозділу: поля + «Замовники» (запрошення з вибором цього підрозділу).
export function renderUnitCard(app, id) {
    const root = h('div', { class: 'kpof-form' }, spinner());
    (async () => {
        const data = await loadAll(app);
        if (data.error) { clear(root, notice(ownFleetErrorText(data.error))); return; }
        const unit = id ? data.units.find((u) => u.id === id) : null;
        if (id && !unit) { clear(root, h('h2', null, 'Підрозділ'), notice('Підрозділ не знайдено.', 'info')); return; }
        const fid = (k) => uniqueId('kpof-u-' + k);
        const ids = { name: fid('name'), kind: fid('kind'), cc: fid('cc') };
        const name = h('input', { id: ids.name, type: 'text', maxlength: 120, required: true, value: unit ? unit.name : '', autocomplete: 'off' });
        const kind = h('select', { id: ids.kind }, kindOptions(UNIT_KINDS, unit ? unit.kind : 'agro'));
        const cc = h('input', { id: ids.cc, type: 'text', maxlength: 60, value: unit ? unit.cost_center || '' : '', autocomplete: 'off' });
        const archived = h('input', { type: 'checkbox', checked: Boolean(unit && unit.archived), id: fid('arch') });
        const message = h('div', { 'aria-live': 'polite' });
        const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
            clear(message);
            if (!name.value.trim()) return clear(message, notice('Вкажіть назву підрозділу.'));
            const payload = { name: name.value.trim(), kind: kind.value, cost_center: cc.value.trim() || null, archived: archived.checked };
            save.disabled = true;
            const { error } = unit
                ? await app.supabase.from('org_units').update(payload).eq('id', unit.id)
                : await app.supabase.from('org_units').insert({ ...payload, org_id: app.ownFleet.org_id });
            save.disabled = false;
            if (error) return clear(message, notice(ownFleetErrorText(error)));
            toast(unit ? 'Підрозділ збережено' : 'Підрозділ додано');
            closeCard(app, true);
        } }, 'Зберегти');
        const body = [h('h2', null, unit ? unit.name : 'Новий підрозділ'),
            row('Назва', name, ids.name), row('Тип', kind, ids.kind), row('Центр витрат', cc, ids.cc),
            unit ? h('div', { class: 'field kpc-row' }, h('label', { for: archived.id }, 'В архіві'), h('span', { class: 'kpc-box' }, archived)) : null,
            message, h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn', onclick: () => closeCard(app, false) }, 'Закрити'))];
        // Запрошення замовників — лише директор і менеджер (API й БД відмовляють логісту).
        if (unit && app.ownFleet && (app.ownFleet.role === 'owner' || app.ownFleet.role === 'director')) body.push(requestersBlock(app, unit));
        clear(root, body);
    })();
    return root;
}

// Замовники підрозділу: скільки прикріплено, відкриті запрошення (надіслати ще раз / скасувати), нове запрошення.
function requestersBlock(app, unit) {
    const box = h('div', { class: 'kpof-requesters' });
    const message = h('div', { 'aria-live': 'polite' });
    async function paint() {
        const [members, invites] = await Promise.all([
            app.supabase.from('org_unit_members').select('user_id').eq('unit_id', unit.id),
            callKpApi({ supabase: app.supabase }, '/api/own-fleet/invites', { action: 'list' }),
        ]);
        const mine = ((invites && invites.invites) || []).filter((i) => (i.unit_ids || []).includes(unit.id) && i.status !== 'accepted');
        const email = h('input', { type: 'email', maxlength: 254, placeholder: 'пошта замовника', 'aria-label': 'Пошта замовника', autocomplete: 'off' });
        const show = (out) => {
            if (!out.ok) return clear(message, notice(out.error || 'Не вдалося виконати дію.'));
            clear(message, out.mail_sent ? notice('Запрошення надіслано на пошту.', 'info')
                : h('div', { class: 'notice notice-info' }, 'Лист не надіслано (пошта не налаштована). Скопіюйте посилання й передайте замовнику: ', h('code', { class: 'kpof-link' }, out.link || '')));
            paint();
        };
        clear(box, h('h3', { class: 'kpc-section' }, 'Замовники підрозділу'),
            h('p', { class: 'muted small' }, 'Прикріплено замовників: ' + ((members.data || []).length) + '. Замовник бачить і створює заявки лише свого підрозділу.'),
            mine.length ? h('ul', { class: 'kpof-log' }, mine.map((i) => h('li', null, i.email, ' — ', { sent: 'очікує', expired: 'строк минув', revoked: 'скасовано' }[i.status] || i.status, ' ',
                i.status === 'sent' || i.status === 'expired' ? h('button', { type: 'button', class: 'btn btn-sm', onclick: async () => show(await callKpApi({ supabase: app.supabase }, '/api/own-fleet/invites', { action: 'resend', id: i.id })) }, 'Надіслати ще раз') : null,
                i.status === 'sent' ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: async () => { await callKpApi({ supabase: app.supabase }, '/api/own-fleet/invites', { action: 'revoke', id: i.id }); paint(); } }, 'Скасувати') : null))) : null,
            h('div', { class: 'kpof-invite-row' }, email, h('button', { type: 'button', class: 'btn', onclick: async () => {
                clear(message);
                if (!email.value.trim()) return clear(message, notice('Вкажіть пошту.'));
                show(await callKpApi({ supabase: app.supabase }, '/api/own-fleet/invites', { action: 'create', email: email.value.trim(), unit_ids: [unit.id] }));
            } }, 'Запросити замовника')), message);
    }
    paint();
    return box;
}

export function renderPointCard(app, id) {
    const root = h('div', { class: 'kpof-form' }, spinner());
    (async () => {
        const data = await loadAll(app);
        if (data.error) { clear(root, notice(ownFleetErrorText(data.error))); return; }
        const point = id ? data.points.find((p) => p.id === id) : null;
        if (id && !point) { clear(root, h('h2', null, 'Точка'), notice('Точку не знайдено.', 'info')); return; }
        const fid = (k) => uniqueId('kpof-p-' + k);
        const ids = { name: fid('name'), kind: fid('kind'), unit: fid('unit'), crop: fid('crop'), area: fid('area'), lat: fid('lat'), lng: fid('lng') };
        const val = (k) => (point && point[k] !== null && point[k] !== undefined ? String(point[k]) : '');
        const name = h('input', { id: ids.name, type: 'text', maxlength: 120, required: true, value: val('name'), autocomplete: 'off' });
        const kind = h('select', { id: ids.kind }, kindOptions(POINT_KINDS, point ? point.kind : 'field'));
        const unit = h('select', { id: ids.unit }, h('option', { value: '' }, '— спільна (без підрозділу) —'),
            data.units.filter((u) => !u.archived || (point && point.unit_id === u.id)).map((u) => h('option', { value: u.id, selected: point && point.unit_id === u.id }, u.name)));
        const crop = h('input', { id: ids.crop, type: 'text', maxlength: 80, value: val('crop'), autocomplete: 'off' });
        const area = h('input', { id: ids.area, type: 'text', inputmode: 'decimal', value: val('area_ha').replace('.', ','), autocomplete: 'off' });
        const lat = h('input', { id: ids.lat, type: 'text', inputmode: 'decimal', value: val('lat'), placeholder: '50.4501', autocomplete: 'off' });
        const lng = h('input', { id: ids.lng, type: 'text', inputmode: 'decimal', value: val('lng'), placeholder: '30.5234', autocomplete: 'off' });
        const archived = h('input', { type: 'checkbox', checked: Boolean(point && point.archived), id: fid('arch') });
        const message = h('div', { 'aria-live': 'polite' });
        const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
            clear(message);
            if (!name.value.trim()) return clear(message, notice('Вкажіть назву точки.'));
            const la = numOrNull(lat.value);
            const lo = numOrNull(lng.value);
            const ar = numOrNull(area.value);
            if ((la === null) !== (lo === null) || [la, lo, ar].some((n) => n !== null && !Number.isFinite(n))) return clear(message, notice('Координати вказуються парою (широта і довгота), площа — числом.'));
            const payload = { name: name.value.trim(), kind: kind.value, unit_id: unit.value || null, crop: crop.value.trim() || null, area_ha: ar, lat: la, lng: lo, archived: archived.checked };
            save.disabled = true;
            const { error } = point
                ? await app.supabase.from('org_points').update(payload).eq('id', point.id)
                : await app.supabase.from('org_points').insert({ ...payload, org_id: app.ownFleet.org_id });
            save.disabled = false;
            if (error) return clear(message, notice(ownFleetErrorText(error)));
            toast(point ? 'Точку збережено' : 'Точку додано');
            if (typeof app.closeWindow === 'function') app.closeWindow(true);
            else { changed(); app.go('#/own-fleet/points'); }
        } }, 'Зберегти');
        clear(root, h('h2', null, point ? point.name : 'Нова точка'),
            row('Назва', name, ids.name), row('Тип', kind, ids.kind), row('Підрозділ', unit, ids.unit), row('Культура', crop, ids.crop), row('Площа, га', area, ids.area),
            row('Широта', lat, ids.lat), row('Довгота', lng, ids.lng),
            point ? h('div', { class: 'field kpc-row' }, h('label', { for: archived.id }, 'В архіві'), h('span', { class: 'kpc-box' }, archived)) : null,
            message, h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn', onclick: () => (typeof app.closeWindow === 'function' ? app.closeWindow(false) : app.go('#/own-fleet/points')) }, 'Закрити')));
    })();
    return root;
}
