// «Водії»: той самий шаблон, що й «Автопарк» (views/registry.js). Пошук ТІЛЬКИ за ПІБ + «Додати водія», список лише для
// читання, клік — картка водія (ПІБ, посвідчення, телефон, паспорт, ІПН, адреса). ПІБ і посвідчення — kp_driver_save
// (власник і логіст, як і для ТТН); телефон / паспорт / ІПН / адреса — персональні дані, kp_driver_details_save (лише
// власник), у ТТН не потрапляють. «Деактивувати» — active = false (водія не видаляємо, він зникає з вибору в ТТН).
import { h, clear, notice, toast, confirmButton } from '../ui.js';
import { docsAccess, isMissingFeature } from '../lib/docs.js';
import { validateDriver, validateDriverDetails } from '../lib/fleet.js';
import { ttnErrorText } from '../lib/ttn.js';
import { DRIVER_FIELDS, driverMatches } from '../lib/registry.js';
import { cardField, cardLayout, renderRegistry, showFieldErrors } from './registry.js';
import { showError } from './docs.js';

export function renderDrivers(app) {
    const access = docsAccess(app.context);
    let vehicles = [];

    function driverCard(row, ctx) {
        const d = row || null;
        const fields = {};
        const message = h('div', { 'aria-live': 'polite' });
        let detailsReady = true;
        const body = DRIVER_FIELDS.map((spec) => {
            if (spec.section) return h('h3', { class: 'kpc-section' }, spec.section);
            const disabled = spec.details ? !access.isOwner : !access.canWrite;
            const f = cardField(spec, d ? d[spec.key] : '', { disabled });
            fields[spec.key] = f;
            return f.row;
        });
        if (d) {
            app.supabase.rpc('kp_driver_details_get', { p_driver: d.id }).then(({ data, error }) => {
                if (error) {
                    detailsReady = false;
                    for (const spec of DRIVER_FIELDS) if (spec.details) fields[spec.key].input.disabled = true;
                    clear(message, notice(isMissingFeature(error) ? 'Особисті дані ще не ввімкнено для вашої компанії (міграцію бази не застосовано).' : ttnErrorText(error), 'info'));
                    return;
                }
                const row0 = (data || [])[0] || {};
                for (const spec of DRIVER_FIELDS) if (spec.details) fields[spec.key].input.value = row0[spec.key] || '';
            }, () => { detailsReady = false; });
        }

        async function persist(active) {
            const values = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.input.value]));
            const base = validateDriver({ full_name: values.full_name, license_no: values.license_no });
            const details = validateDriverDetails(values);
            const errors = { ...base.errors, ...(access.isOwner && detailsReady ? details.errors : {}) };
            showFieldErrors(fields, errors);
            if (Object.keys(errors).length) {
                clear(message, notice('Перевірте поля водія.'));
                return false;
            }
            const saved = await app.supabase.rpc('kp_driver_save', { p_id: d ? d.id : null, p_full_name: base.data.full_name, p_license_no: base.data.license_no, p_active: active });
            if (saved.error) {
                clear(message, notice(ttnErrorText(saved.error)));
                return false;
            }
            if (access.isOwner && detailsReady) {
                const { error } = await app.supabase.rpc('kp_driver_details_save', {
                    p_driver: saved.data, p_phone: details.data.phone, p_passport: details.data.passport, p_ipn: details.data.ipn, p_address: details.data.address,
                });
                if (error) {
                    clear(message, notice(ttnErrorText(error)));
                    return false;
                }
            }
            clear(message);
            return true;
        }

        const save = async () => {
            if (await persist(d ? d.active : true)) {
                toast(d ? 'Водія збережено' : 'Водія додано');
                ctx.close(true);
            }
        };
        const toggle = async () => {
            if (await persist(!d.active)) {
                toast(d.active ? 'Водія деактивовано' : 'Водія повернено');
                ctx.close(true);
            }
        };
        return cardLayout({
            title: d ? d.full_name : 'Новий водій', fields: body, message, back: ctx.back,
            actions: [
                access.canWrite ? h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Зберегти') : null,
                d && access.canWrite
                    ? (d.active ? confirmButton('Деактивувати', 'Точно деактивувати водія?', toggle, 'btn btn-danger')
                        : h('button', { type: 'button', class: 'btn', onclick: toggle }, 'Повернути'))
                    : null,
            ],
        });
    }

    return renderRegistry(app, {
        id: 'kpd',
        title: 'Водії',
        searchLabel: 'ПІБ',
        searchPlaceholder: 'Прізвище або імʼя',
        addLabel: 'Додати водія',
        canAdd: access.canWrite,
        columns: [
            { label: 'ПІБ', cell: (r) => r.full_name },
            { label: 'Посвідчення', mono: true, cell: (r) => r.license_no || '—' },
            { label: 'Закріплене авто', cell: (r) => vehicles.filter((v) => v.default_driver_id === r.id).map((v) => v.label).join(', ') || '—' },
            { label: 'Статус', cell: (r) => (r.active ? 'активний' : 'неактивний') },
        ],
        match: (r, q) => driverMatches(r.full_name, q),
        rowTitle: (r) => r.full_name,
        rowClass: (r) => (r.active ? '' : 'is-archived'),
        emptyText: access.canWrite ? 'Водіїв ще немає — натисніть «Додати водія».' : 'Скоро тут будуть водії.',
        onError: (box, error) => showError(app, box, error),
        load: async () => {
            const [drv, veh] = await Promise.all([app.supabase.rpc('kp_driver_list', { p_active_only: false }), app.supabase.rpc('kp_vehicles_list')]);
            if (drv.error) throw drv.error;
            vehicles = veh.error ? [] : (veh.data || []);
            return drv.data || [];
        },
        renderCard: driverCard,
    });
}
