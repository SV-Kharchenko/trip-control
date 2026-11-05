// Вкладка «Документи» → «Інше»: довіреності, страховки, скани. Файл — у приватному бакеті kp-other-docs (відкриття через
// підписане посилання на 10 хв). Додавати можуть owner і логіст, анулювати й видаляти — лише owner; director лише дивиться.
// Кнопки — за розміром вмісту.
import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { statusOptions, validityBadge } from '../lib/docs-tabs.js';
import {
    OTHER_ACCEPT, OTHER_BUCKET, OTHER_CATEGORIES, OTHER_CATEGORY_LABELS, OTHER_URL_SECONDS,
    extOf, otherContentType, otherErrorText, otherFileProblem, otherPath,
} from '../lib/other-docs.js';
import { isMissingFeature } from '../lib/docs.js';
import { labelHint } from '../lib/field-hint.js';
import { OTHER_HINTS } from '../lib/form-hints.js';

const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12));
const labeled = (text, control) => h('label', { class: 'kpd-f' }, h('span', null, text), control);
const field = (label, id, control) => h('div', { class: 'field' }, labelHint(h('label', { for: id }, label), OTHER_HINTS[id.replace(/^kpo-/, '')]), control);

// Підписане посилання на файл бакета в новій вкладці.
export async function openSigned(app, bucket, path, errorText) {
    const { data, error } = await app.supabase.storage.from(bucket).createSignedUrl(path, OTHER_URL_SECONDS);
    if (error || !data || !data.signedUrl) return toast(errorText(error) || 'Не вдалося відкрити файл', 'error');
    window.open(data.signedUrl, '_blank', 'noopener');
    return null;
}

// Анулювання з причиною: поле причини + підтвердження. run(reason) → { error }.
export function reasonCancel(run, onDone, errorText) {
    const box = h('div', { class: 'kpd-cancel' });
    const start = () => h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: open }, 'Анулювати…');
    function open() {
        const reason = h('input', { type: 'text', maxlength: 500, placeholder: 'Причина анулювання', 'aria-label': 'Причина анулювання', class: 'grow' });
        const go = async () => {
            const text = reason.value.trim();
            if (!text) {
                toast('Вкажіть причину анулювання', 'error');
                reason.focus();
                return;
            }
            const { error } = await run(text);
            if (error) return toast(errorText(error), 'error');
            toast('Анульовано');
            return onDone();
        };
        clear(box, reason, confirmButton('Анулювати', 'Точно анулювати?', go, 'btn btn-sm btn-danger'),
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => clear(box, start()) }, 'Скасувати'));
        reason.focus();
    }
    clear(box, start());
    return box;
}

export function renderOtherDocs(app, access) {
    const from = h('input', { type: 'date', 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', 'aria-label': 'Період по' });
    const category = h('select', { 'aria-label': 'Категорія' }, h('option', { value: '' }, 'Усі категорії'),
        OTHER_CATEGORIES.map(([v, l]) => h('option', { value: v }, l)));
    const status = h('select', { 'aria-label': 'Статус' }, statusOptions('other').map(([v, l]) => h('option', { value: v }, l)));
    const client = h('select', { 'aria-label': 'Клієнт' }, h('option', { value: '' }, 'Усі клієнти'));
    const list = h('div', { class: 'list' }, spinner());
    const formBox = h('div');
    let lists = null;

    async function loadLists() {
        if (lists) return lists;
        const [clients, vehicles, drivers, calcs] = await Promise.all([
            app.supabase.from('clients').select('id, name, archived_at').order('name', { ascending: true }).limit(2000),
            app.supabase.from('fleet_vehicles').select('id, label').order('label', { ascending: true }).limit(500),
            app.supabase.from('kp_drivers').select('id, full_name, active').order('full_name', { ascending: true }).limit(500),
            app.supabase.rpc('kp_calc_accepted_list', { p_q: null }),
        ]);
        lists = {
            clients: clients.data || [], vehicles: vehicles.data || [], drivers: drivers.data || [],
            calcs: calcs.error ? [] : (calcs.data || []),
        };
        return lists;
    }

    async function load() {
        if (from.value && to.value && from.value > to.value) {
            clear(list, notice('Перевірте період: «з» не пізніше «по».'));
            return;
        }
        clear(list, spinner());
        const { data, error } = await app.supabase.rpc('kp_other_list', {
            p_from: from.value || null, p_to: to.value || null, p_category: category.value || null, p_client: client.value || null, p_status: status.value || null,
        });
        if (error) {
            clear(list, isMissingFeature(error) ? notice('Розділ «Інше» ще не ввімкнено для вашої компанії (міграцію бази не застосовано).', 'info') : notice(otherErrorText(error)));
            return;
        }
        const rows = data || [];
        if (!rows.length) {
            clear(list, h('div', { class: 'empty' }, h('b', null, 'Файлів ще немає'),
                h('p', { class: 'muted' }, 'Довіреності, страхові поліси, сканкопії — усе, що не потрапляє в інші вкладки.' + (access.canWrite ? ' Додайте перший файл кнопкою вгорі.' : ''))));
            return;
        }
        clear(list, h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Дата', 'Назва', 'Категорія', 'Прив’язка', 'Діє до', 'Статус', ''].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((r) => {
                const badge = validityBadge({ ...r, status: r.status });
                const links = [r.client_name, r.vehicle_label, r.driver_name, r.calculation_id ? 'заявка' : null].filter(Boolean).join(' · ');
                return h('tr', { class: r.status === 'cancelled' ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Дата' }, fmtDate(r.doc_date)),
                    h('td', { 'data-label': 'Назва' }, h('b', null, r.title), h('div', { class: 'muted small' }, r.file_name),
                        r.cancel_reason ? h('div', { class: 'muted small' }, 'Причина анулювання: ' + r.cancel_reason) : null),
                    h('td', { 'data-label': 'Категорія' }, OTHER_CATEGORY_LABELS[r.category] || r.category),
                    h('td', { 'data-label': 'Прив’язка' }, links || '—'),
                    h('td', { 'data-label': 'Діє до' }, r.valid_until ? fmtDate(r.valid_until) : '—'),
                    h('td', { 'data-label': 'Статус' }, h('span', { class: 'kpd-st kpd-st-' + badge.key }, badge.label)),
                    h('td', { 'data-label': '' }, h('div', { class: 'actions' },
                        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openSigned(app, OTHER_BUCKET, r.file_path, otherErrorText) }, 'Відкрити'),
                        access.isOwner && r.status === 'active' ? reasonCancel((reason) => app.supabase.rpc('kp_other_cancel', { p_id: r.id, p_reason: reason }), load, otherErrorText) : null,
                        access.isOwner ? confirmButton('Видалити', 'Точно видалити?', async () => {
                            // Спершу файл, потім запис: база не видаляє запис, поки файл ще в бакеті.
                            const removed = await app.supabase.storage.from(OTHER_BUCKET).remove([r.file_path]);
                            if (removed.error) return toast(otherErrorText(removed.error), 'error');
                            const { error: delError } = await app.supabase.rpc('kp_other_delete', { p_id: r.id });
                            if (delError) return toast(otherErrorText(delError), 'error');
                            toast('Файл видалено');
                            return load();
                        }, 'btn btn-sm btn-danger') : null)));
            })))));
    }

    async function openForm() {
        const l = await loadLists();
        const today = kyivDate();
        const f = {
            title: h('input', { type: 'text', id: 'kpo-title', maxlength: 200 }),
            category: h('select', { id: 'kpo-cat' }, OTHER_CATEGORIES.map(([v, label]) => h('option', { value: v }, label))),
            date: h('input', { type: 'date', id: 'kpo-date', value: today }),
            valid: h('input', { type: 'date', id: 'kpo-valid' }),
            client: h('select', { id: 'kpo-client' }, h('option', { value: '' }, 'Без клієнта'),
                l.clients.filter((c) => !c.archived_at).map((c) => h('option', { value: c.id }, c.name))),
            vehicle: h('select', { id: 'kpo-vehicle' }, h('option', { value: '' }, 'Без авто'), l.vehicles.map((v) => h('option', { value: v.id }, v.label))),
            driver: h('select', { id: 'kpo-driver' }, h('option', { value: '' }, 'Без водія'),
                l.drivers.filter((d) => d.active !== false).map((d) => h('option', { value: d.id }, d.full_name))),
            calc: h('select', { id: 'kpo-calc' }, h('option', { value: '' }, 'Без заявки'),
                l.calcs.map((c) => h('option', { value: c.calculation_id }, [c.trip_date ? fmtDate(c.trip_date) : null, c.name || [c.route_from, c.route_to].filter(Boolean).join(' → ')].filter(Boolean).join(' · ')))),
            file: h('input', { type: 'file', id: 'kpo-file', accept: OTHER_ACCEPT }),
        };
        const status = h('div', { 'aria-live': 'polite' });
        const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Зберегти');
        save.onclick = async () => {
            const file = f.file.files && f.file.files[0];
            const problem = otherFileProblem(file);
            if (!f.title.value.trim() || !f.date.value) return clear(status, notice('Вкажіть назву й дату.'));
            if (f.valid.value && f.valid.value < f.date.value) return clear(status, notice('Строк дії не може бути раніше дати документа.'));
            if (problem) return clear(status, notice(problem));
            save.disabled = true;
            clear(status, h('p', { class: 'muted' }, 'Завантажуємо…'));
            const id = uuid();
            const path = otherPath(app.context && app.context.org_id, id, extOf(file.name), uuid());
            const up = await app.supabase.storage.from(OTHER_BUCKET).upload(path, file, { contentType: otherContentType(file), upsert: false });
            if (up.error) {
                save.disabled = false;
                return clear(status, notice(otherErrorText(up.error)));
            }
            const { error } = await app.supabase.rpc('kp_other_save', {
                p_id: id,
                p_data: {
                    title: f.title.value.trim(), category: f.category.value, doc_date: f.date.value, valid_until: f.valid.value || '',
                    client_id: f.client.value, vehicle_id: f.vehicle.value, driver_id: f.driver.value, calculation_id: f.calc.value,
                    file_path: path, file_name: file.name,
                },
            });
            save.disabled = false;
            if (error) {
                // Запису немає — одразу прибираємо щойно завантажений файл (автору дозволено видаляти власний файл без запису).
                await app.supabase.storage.from(OTHER_BUCKET).remove([path]).catch(() => null);
                return clear(status, notice(otherErrorText(error)));
            }
            clear(formBox);
            toast('Файл додано');
            return load();
        };
        clear(formBox, h('div', { class: 'card kpk-form' }, h('h3', null, 'Новий файл'),
            h('div', { class: 'form' },
                field('Назва', 'kpo-title', f.title), field('Категорія', 'kpo-cat', f.category), field('Дата', 'kpo-date', f.date),
                field('Діє до (необов’язково)', 'kpo-valid', f.valid), field('Клієнт', 'kpo-client', f.client), field('Авто', 'kpo-vehicle', f.vehicle),
                field('Водій', 'kpo-driver', f.driver), field('Заявка', 'kpo-calc', f.calc),
                field('Файл (PDF, JPG, PNG, Word, Excel до 10 МБ)', 'kpo-file', f.file), status,
                h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => clear(formBox) }, 'Скасувати')))));
    }

    async function loadClients() {
        const l = await loadLists();
        for (const c of l.clients) client.append(h('option', { value: c.id }, c.name + (c.archived_at ? ' (архів)' : '')));
    }

    for (const el of [from, to, category, status, client]) el.addEventListener('change', load);
    loadClients().then(load, load);
    return h('div', null,
        h('div', { class: 'toolbar kpd-filters' }, labeled('Період з', from), labeled('по', to), labeled('Категорія', category), labeled('Статус', status), labeled('Клієнт', client)),
        access.canWrite ? h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: openForm }, 'Додати файл')) : null,
        formBox, list);
}
