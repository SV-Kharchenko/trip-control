// Створення ТТН (форма № 1-ТН): з рейсу (#/docs/new/ttn/<клієнт>/<рейс>), з клієнта або порожня. Підказки — kp_ttn_prefill
// (нічого не пише): замовник — клієнт, перевізник — наші реквізити, авто рейсу з габаритами й тарою, водій за
// замовчуванням, пункти маршруту. Вантажовідправник і вантажоодержувач порожні — вибір в один клік «Клієнт» /
// «Наша компанія» / «Вручну». Усе можна правити; обовʼязкові поля підсвічуються одразу, перевірка — як на сервері.
import { h, clear, spinner, notice, toast } from '../ui.js';
import { fmtDate, kyivDate } from '../lib/format.js';
import { callKpApi } from '../lib/gps-client.js';
import {
    TTN_FIELD_LABELS, TTN_MAX_LINES, TTN_REQUIRED, TTN_TRAILER_REQUIRED, createTtn, emptyLine, linesGross, massWarning, totalMass,
    ttnErrorField, ttnErrorText, ttnFromPrefill, ttnPayload, validateTtn,
} from '../lib/ttn.js';
import { showError } from './docs.js';

function shiftDays(iso, days) {
    return new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) o = o[k] || (o[k] = {});
    o[keys[keys.length - 1]] = value;
}

const fmtT = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : String(n).replace('.', ','));

export function renderTtnForm(app, access, route) {
    const root = h('div', null, spinner());
    (async () => {
        const [req, cl, drv, veh, trl] = await Promise.all([
            app.supabase.rpc('kp_requisites_get'),
            app.supabase.from('clients').select('id, name, archived_at').order('name', { ascending: true }).limit(2000),
            app.supabase.rpc('kp_driver_list', { p_active_only: true }),
            app.supabase.rpc('kp_vehicles_list'),
            app.supabase.rpc('kp_trailers_list'),
        ]);
        if (req.error) return showError(app, root, req.error);
        if (drv.error) return showError(app, root, drv.error);
        const requisites = (req.data || [])[0];
        if (!requisites || (!requisites.edrpou && !requisites.ipn)) {
            clear(root, notice('Спершу заповніть реквізити компанії — перевізник у ТТН завжди ваша компанія (назва і ЄДРПОУ або ІПН).', 'info'),
                access.isOwner ? h('a', { class: 'btn btn-primary', href: '#/docs/requisites' }, 'Заповнити реквізити')
                    : h('p', { class: 'muted' }, 'Реквізити заповнює власник компанії.'));
            return;
        }
        const clients = (cl.data || []).filter((c) => !c.archived_at);
        clear(root, buildForm(app, route, clients, drv.data || [], veh.error ? [] : veh.data || [], trl.error ? [] : (trl.data || []).filter((t) => t.active)));
    })();
    return root;
}

function buildForm(app, route, clients, drivers, vehicles, trailers = []) {
    const today = kyivDate();
    let d = ttnFromPrefill(null);
    let pre = null;
    let tried = false;
    const touched = { gross: false, lineGross: false };
    const fields = {};
    const message = h('div', { 'aria-live': 'polite' });
    const body = h('div', { class: 'kpt-body' });
    const requiredPaths = new Set(TTN_REQUIRED.map(([p]) => p));
    const trailerPaths = new Set(TTN_TRAILER_REQUIRED.map(([p]) => p));

    const clientSel = h('select', { id: 't-client', required: true },
        h('option', { value: '' }, '— оберіть клієнта (замовника) —'),
        clients.map((c) => h('option', { value: c.id, selected: c.id === route.client }, c.name)));
    const docDate = h('input', { type: 'date', id: 't-date', value: today, max: shiftDays(today, 1) });
    const number = h('input', { type: 'number', id: 't-number', min: 1, step: 1, inputmode: 'numeric', placeholder: 'авто' });
    const numberHint = h('div', { class: 'hint' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Створити ТТН');
    const massBox = h('div', { class: 'kpr-totals kpt-mass', 'aria-live': 'polite' });

    const isRequired = (path) => requiredPaths.has(path) || (trailerPaths.has(path) && Boolean(d.vehicle.trailer_reg_number || d.vehicle.trailer_make_model));

    // Підсвітка: порожнє обовʼязкове — одразу (kpt-missing), текст помилки — після першої спроби створити.
    function paint() {
        const errors = validateTtn(d);
        for (const [path, f] of Object.entries(fields)) {
            const value = getPath(d, path);
            const missing = isRequired(path) && (value === null || value === undefined || String(value).trim() === '');
            f.wrap.classList.toggle('kpt-missing', missing);
            const err = tried ? errors[path] : null;
            f.input.toggleAttribute('aria-invalid', Boolean(err));
            f.hint.textContent = err || f.baseHint || '';
            f.hint.className = 'hint' + (err ? ' hint-error' : '');
            if (f.req) f.req.hidden = !isRequired(path);
        }
        drawMass();
        return errors;
    }

    function drawMass() {
        const total = totalMass(d.tare_t, d.cargo_gross_t);
        const warn = massWarning(d.tare_t, d.cargo_gross_t, d.max_mass_t);
        const sum = linesGross(d.lines);
        clear(massBox,
            h('span', null, 'Загальна маса з вантажем: ', h('b', null, total === null ? '—' : fmtT(total) + ' т'), h('span', { class: 'muted small' }, ' = тара + брутто')),
            sum !== null ? h('span', { class: 'muted small' }, 'Сума брутто в рядках: ' + fmtT(sum) + ' т') : null,
            warn ? h('span', { class: 'hint hint-warn', role: 'status' }, warn + ' (попередження, створити можна)') : null);
    }

    // Поле, привʼязане до шляху в d.
    function field(path, label, attrs = {}, opts = {}) {
        const id = 't-' + path.replace(/\./g, '-');
        const tag = opts.textarea ? 'textarea' : 'input';
        const input = h(tag, Object.assign({ id, autocomplete: 'off' }, opts.textarea ? { rows: 2 } : { type: 'text' }, attrs));
        const value = getPath(d, path);
        input.value = value === null || value === undefined ? '' : String(value);
        const hint = h('div', { class: 'hint', id: id + '-hint', 'aria-live': 'polite' });
        input.setAttribute('aria-describedby', id + '-hint');
        input.addEventListener('input', () => {
            setPath(d, path, input.value);
            if (opts.onInput) opts.onInput(input.value);
            paint();
        });
        const req = h('span', { class: 'req', 'aria-hidden': 'true' }, ' *');
        const wrap = h('div', { class: 'field' + (opts.wide ? ' kpr-wide' : ''), 'data-path': path }, h('label', { for: id }, label || TTN_FIELD_LABELS[path] || path, req), input, hint);
        fields[path] = { input, hint, wrap, req, baseHint: opts.hint || '' };
        return wrap;
    }

    function numField(path, label, opts = {}) {
        return field(path, label, { inputmode: 'decimal', placeholder: opts.placeholder || '0,000' }, opts);
    }

    // Сторона: кнопки «Клієнт» / «Наша компанія» / «Вручну» (порожні за замовчуванням).
    function partyBlock(key, title, { choices = true, note } = {}) {
        const box = h('div', { class: 'card kpt-party' });
        const draw = () => {
            const options = pre && pre.party_options ? pre.party_options : {};
            const pick = (p) => {
                d[key] = p ? { name: p.name || '', code: p.code || '', address: p.address || '' } : { name: '', code: '', address: '' };
                draw();
                paint();
            };
            clear(box,
                h('h3', { class: 'kpd-party-title' }, title),
                note ? h('p', { class: 'muted small' }, note) : null,
                choices ? h('div', { class: 'segmented kpt-choice', role: 'group', 'aria-label': title + ': заповнити' },
                    h('button', { type: 'button', disabled: !options.client, onclick: () => pick(options.client) }, 'Клієнт'),
                    h('button', { type: 'button', disabled: !options.ours, onclick: () => pick(options.ours) }, 'Наша компанія'),
                    h('button', { type: 'button', onclick: () => pick(null) }, 'Вручну')) : null,
                h('div', { class: 'kpd-grid' },
                    field(key + '.name', 'Повне найменування / ПІБ', { maxlength: 300 }, { wide: true }),
                    field(key + '.code', 'Код ЄДРПОУ / РНОКПП / паспорт', { maxlength: 12, class: 'mono', inputmode: 'text' }, { hint: '8 цифр — ЄДРПОУ, 10 — РНОКПП, 9 — ID-картка, 2 літери + 6 цифр — паспорт' }),
                    field(key + '.address', 'Адреса / місцезнаходження', { maxlength: 500 })));
        };
        draw();
        return box;
    }

    function carrierBlock() {
        const c = (pre && pre.carrier) || {};
        return h('div', { class: 'card kpt-party' },
            h('h3', { class: 'kpd-party-title' }, 'Автомобільний перевізник'),
            h('p', { class: 'kpd-party-name' }, c.name || '—'),
            h('p', { class: 'small' }, [c.code ? 'Код ' + c.code : null, c.address].filter(Boolean).join(', ') || '—'),
            h('p', { class: 'muted small' }, 'Перевізник — завжди ваша компанія (реквізити). Підпис і печатка — зі знімка реквізитів на момент створення.'));
    }

    function applyVehicle(v) {
        if (!v) return;
        d.vehicle_id = v.id;
        Object.assign(d.vehicle, {
            make_model: v.make_model || '', type: v.vehicle_type || '', reg_number: v.label || '',
            trailer_make_model: v.trailer_make_model || '', trailer_type: v.trailer_type || '', trailer_reg_number: v.trailer_plate || '',
            length_m: v.length_m ?? '', width_m: v.width_m ?? '', height_m: v.height_m ?? '',
        });
        d.tare_t = v.tare_t ?? '';
        d.max_mass_t = v.max_mass_t ?? '';
        const drv = drivers.find((x) => x.id === v.default_driver_id);
        if (drv) d.driver = { id: drv.id, full_name: drv.full_name, license_no: drv.license_no || '' };
    }

    // Причіп з автопарку (fleet_trailers): підставляє марку, тип і номер у знімок ТТН; поля лишаються редагованими.
    function applyTrailer(t) {
        Object.assign(d.vehicle, {
            trailer_make_model: t ? t.make_model || '' : '', trailer_type: t ? t.type || '' : '', trailer_reg_number: t ? t.plate || '' : '',
        });
    }

    function transportSection() {
        const tripIds = new Set(((pre && pre.vehicles) || []).map((v) => v.id));
        const sorted = [...vehicles].sort((a, b) => Number(tripIds.has(b.id)) - Number(tripIds.has(a.id)));
        const vehicleSel = h('select', { id: 't-vehicle', 'aria-label': 'Авто з автопарку' },
            h('option', { value: '' }, vehicles.length ? '— авто з автопарку (заповнить поля) —' : 'Авто ще немає — заповніть вручну'),
            sorted.map((v) => h('option', { value: v.id, selected: v.id === d.vehicle_id }, v.label + (v.make_model ? ' · ' + v.make_model : '') + (tripIds.has(v.id) ? ' (рейс)' : ''))));
        vehicleSel.addEventListener('change', () => {
            applyVehicle(vehicles.find((v) => v.id === vehicleSel.value));
            drawBody();
        });
        const driverSel = h('select', { id: 't-driver', 'aria-label': 'Водій з довідника' },
            h('option', { value: '' }, drivers.length ? '— водій з довідника —' : 'Довідник водіїв порожній — вкажіть вручну'),
            drivers.map((x) => h('option', { value: x.id, selected: x.id === (d.driver && d.driver.id) }, x.full_name + (x.license_no ? ' · ' + x.license_no : ''))));
        driverSel.addEventListener('change', () => {
            const x = drivers.find((y) => y.id === driverSel.value);
            d.driver = x ? { id: x.id, full_name: x.full_name, license_no: x.license_no || '' } : { id: null, full_name: '', license_no: '' };
            if (x && !String(d.received_by || '').trim()) d.received_by = x.full_name + ', водій';
            drawBody();
        });
        const picked = trailers.find((t) => d.vehicle.trailer_reg_number && String(t.plate).toLowerCase() === String(d.vehicle.trailer_reg_number).toLowerCase());
        const trailerSel = h('select', { id: 't-trailer', 'aria-label': 'Причіп з автопарку' },
            h('option', { value: '' }, trailers.length ? '— причіп з автопарку (заповнить поля) —' : 'Причепів ще немає — заповніть вручну'),
            trailers.map((t) => h('option', { value: t.id, selected: Boolean(picked && picked.id === t.id) }, t.plate + (t.make_model ? ' · ' + t.make_model : ''))));
        trailerSel.addEventListener('change', () => {
            applyTrailer(trailers.find((t) => t.id === trailerSel.value));
            drawBody();
        });
        return [
            h('h2', { class: 'form-section' }, 'Транспорт і водій'),
            h('div', { class: 'kpd-grid' },
                h('div', { class: 'field' }, h('label', { for: 't-vehicle' }, 'Авто'), vehicleSel, h('div', { class: 'hint' }, 'Поля ТЗ редагуються в «Авто й водії» або тут лише для цієї ТТН.')),
                h('div', { class: 'field' }, h('label', { for: 't-driver' }, 'Водій'), driverSel),
                field('vehicle.make_model', null, { maxlength: 100, placeholder: 'напр. DAF XF 480' }),
                field('vehicle.type', null, { maxlength: 100, placeholder: 'напр. тягач сідловий' }),
                field('vehicle.reg_number', null, { maxlength: 20, class: 'mono', placeholder: 'напр. AA0000AA' }),
                field('driver.full_name', null, { maxlength: 200 }),
                field('driver.license_no', null, { maxlength: 30, class: 'mono' }),
                h('div', { class: 'field' }, h('label', { for: 't-trailer' }, 'Причіп'), trailerSel),
                field('vehicle.trailer_make_model', 'Причіп / напівпричіп: марка, модель', { maxlength: 100 }),
                field('vehicle.trailer_type', 'Причіп: тип', { maxlength: 100, placeholder: 'напр. напівпричіп-зерновоз' }),
                field('vehicle.trailer_reg_number', 'Причіп: реєстраційний номер', { maxlength: 20, class: 'mono' }),
                numField('vehicle.length_m', null, { placeholder: 'напр. 16,5', hint: 'Автопоїзд разом' }),
                numField('vehicle.width_m', null, { placeholder: 'напр. 2,55' }),
                numField('vehicle.height_m', null, { placeholder: 'напр. 4' }),
                field('transport_kind', 'Вид перевезень', { maxlength: 100, placeholder: 'напр. внутрішнє' }),
                field('vehicle_parking_place', 'Місце, де зберігається автомобіль*', { maxlength: 500 }, { hint: '* за потреби (Положення про робочий час водіїв)' })),
        ];
    }

    function lineRow(line, index) {
        const bind = (key, attrs) => {
            const input = h('input', Object.assign({ type: 'text', autocomplete: 'off', value: line[key] === null || line[key] === undefined ? '' : String(line[key]) }, attrs));
            input.addEventListener('input', () => {
                line[key] = input.value;
                if (key === 'gross_t') touched.lineGross = true;
                paint();
            });
            return input;
        };
        const check = (key, label) => {
            const input = h('input', { type: 'checkbox', checked: Boolean(line[key]) });
            input.addEventListener('change', () => {
                line[key] = input.checked;
                if (key === 'owner_price' && input.checked) line.price = '';
                drawBody();
            });
            return h('label', { class: 'check' }, input, ' ', label);
        };
        const n = index + 1;
        return h('div', { class: 'kpt-line', 'data-line': String(index) },
            h('div', { class: 'kpt-line-main' },
                bind('cargo_name', { maxlength: 500, 'aria-label': 'Найменування вантажу, рядок ' + n, placeholder: 'Найменування вантажу / № контейнера', class: 'kpt-cargo' }),
                bind('unit', { maxlength: 20, 'aria-label': 'Одиниця вимірювання (т, кг, шт), рядок ' + n, placeholder: 'од.: т, кг, шт', title: 'Назва одиниці вимірювання: т, кг, шт. Кількість вписуйте в «місць» і «брутто, т»' }),
                bind('places', { inputmode: 'numeric', 'aria-label': 'Кількість місць, рядок ' + n, placeholder: 'місць' }),
                line.owner_price ? h('span', { class: 'muted small' }, 'ОЦВТ') : bind('price', { inputmode: 'decimal', 'aria-label': 'Ціна без ПДВ, рядок ' + n, placeholder: 'ціна' }),
                bind('amount', { inputmode: 'decimal', 'aria-label': 'Сума з ПДВ, рядок ' + n, placeholder: 'сума' }),
                bind('packaging', { maxlength: 100, 'aria-label': 'Вид пакування, рядок ' + n, placeholder: 'Насипом' }),
                bind('gross_t', { inputmode: 'decimal', 'aria-label': 'Маса брутто, т, рядок ' + n, placeholder: 'брутто, т' }),
                h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': 'Прибрати рядок ' + n, disabled: d.lines.length <= 1,
                    onclick: () => { d.lines.splice(index, 1); drawBody(); } }, '✕')),
            h('div', { class: 'kpt-line-extra' },
                check('owner_price', 'Облікова ціна власника (ОЦВТ)'),
                check('bulk', 'Насип / налив (брутто = нетто)'),
                bind('docs', { maxlength: 300, 'aria-label': 'Документи з вантажем, рядок ' + n, placeholder: 'Документи з вантажем' }),
                bind('temperature', { maxlength: 50, 'aria-label': 'Температурний режим, рядок ' + n, placeholder: 'Температура***' }),
                bind('animal_id', { maxlength: 100, 'aria-label': 'Ідентифікаційний номер тварини, рядок ' + n, placeholder: 'ID тварини**' }),
                bind('animal_kind', { maxlength: 100, 'aria-label': 'Вид тварини, рядок ' + n, placeholder: 'Вид тварини**' })));
    }

    function cargoSection() {
        const lineErr = tried ? Object.entries(validateTtn(d)).filter(([k]) => k === 'lines' || k.startsWith('lines.')).map(([, v]) => v) : [];
        return [
            h('h2', { class: 'form-section' }, 'Вантаж'),
            h('div', { class: 'kpt-lines' }, d.lines.map(lineRow),
                h('button', { type: 'button', class: 'btn btn-sm', disabled: d.lines.length >= TTN_MAX_LINES,
                    onclick: () => { d.lines.push(emptyLine()); drawBody(); } }, '+ Рядок вантажу'),
                lineErr.length ? h('div', { class: 'hint hint-error', role: 'alert' }, lineErr.join(' · ')) : null),
            h('div', { class: 'kpd-grid' },
                numField('cargo_net_t', null, { onInput: (value) => { if (!touched.gross) { d.cargo_gross_t = value; syncInput('cargo_gross_t'); } syncLineGross(); } }),
                numField('cargo_gross_t', null, { onInput: () => { touched.gross = true; syncLineGross(); }, hint: 'Для насипу / наливу — дорівнює нетто' }),
                numField('tare_t', null, { hint: 'З картки авто; можна виправити для цієї ТТН' }),
                numField('max_mass_t', null, { hint: 'Лише для попередження' }),
                field('places_count', 'Кількість місць (усього)', { inputmode: 'numeric', placeholder: '0' }, { hint: 'Друкується словами' }),
                field('accompanying_docs', null, { maxlength: 500 }),
                numField('total_amount', 'Усього відпущено на суму, грн (з ПДВ)', { placeholder: '0,00', hint: 'Порожньо — «ОЦВТ», якщо ціна власника, або прочерк' }),
                numField('vat_amount', 'У тому числі ПДВ, грн', { placeholder: '0,00' }),
                field('seal_note', 'Номер пломби (додатковий реквізит)', { maxlength: 300 })),
            massBox,
        ];
    }

    function syncInput(path) {
        const f = fields[path];
        if (f && document.activeElement !== f.input) f.input.value = getPath(d, path) ?? '';
    }

    // Один рядок вантажу: його маса брутто йде за масою вантажу, доки користувач не змінив її сам.
    function syncLineGross() {
        if (d.lines.length === 1 && !touched.lineGross) {
            d.lines[0].gross_t = d.cargo_gross_t;
            const input = body.querySelector('[data-line="0"] input[aria-label^="Маса брутто"]');
            if (input) input.value = d.cargo_gross_t ?? '';
        }
    }

    function operationsSection() {
        const row = (op, label) => {
            const o = d.operations.find((x) => x.op === op) || (d.operations[d.operations.push({ op }) - 1]);
            const bind = (key, attrs) => {
                const input = h('input', Object.assign({ type: 'text', autocomplete: 'off', value: o[key] ?? '' }, attrs));
                input.addEventListener('input', () => { o[key] = input.value; });
                return input;
            };
            return h('div', { class: 'kpt-op' },
                h('b', null, label),
                bind('gross_t', { inputmode: 'decimal', placeholder: 'брутто, т', 'aria-label': label + ': маса брутто, т' }),
                bind('tare_t', { inputmode: 'decimal', placeholder: 'тара, т', 'aria-label': label + ': тара, т' }),
                bind('net_t', { inputmode: 'decimal', placeholder: 'нетто, т', 'aria-label': label + ': нетто, т' }),
                bind('arrival', { maxlength: 20, placeholder: 'прибуття 08:00', 'aria-label': label + ': час прибуття' }),
                bind('departure', { maxlength: 20, placeholder: 'вибуття 09:30', 'aria-label': label + ': час вибуття' }),
                bind('idle', { maxlength: 20, placeholder: 'простій 0 год 30 хв', 'aria-label': label + ': час простою' }));
        };
        const fill = () => {
            const total = totalMass(d.tare_t, d.cargo_gross_t);
            const o = d.operations.find((x) => x.op === 'load');
            Object.assign(o, { gross_t: total ?? '', tare_t: d.tare_t ?? '', net_t: d.cargo_net_t || d.cargo_gross_t || '' });
            drawBody();
        };
        return [
            h('h2', { class: 'form-section' }, 'Операції'),
            h('p', { class: 'muted small' }, 'Вантажно-розвантажувальні операції: маса брутто / тара / нетто друкується як «39,84/15,75/24,09». Можна лишити порожнім — заповнять на місці.'),
            row('load', 'Завантаження'),
            row('unload', 'Розвантаження'),
            h('button', { type: 'button', class: 'btn btn-sm', onclick: fill }, 'Заповнити завантаження масами з форми'),
        ];
    }

    function drawBody() {
        for (const key of Object.keys(fields)) delete fields[key];
        clear(body,
            h('h2', { class: 'form-section' }, 'Сторони'),
            h('div', { class: 'grid-2 kpt-parties' },
                carrierBlock(),
                partyBlock('customer', 'Замовник (платник)', { choices: false, note: 'Додатковий реквізит (п. 11.1 Правил): клієнт, для якого рейс. Можна очистити.' }),
                partyBlock('shipper', 'Вантажовідправник'),
                partyBlock('consignee', 'Вантажоодержувач')),
            ...transportSection(),
            h('h2', { class: 'form-section' }, 'Маршрут'),
            h('div', { class: 'kpd-grid' },
                field('place_of_issue', null, { maxlength: 200, placeholder: 'напр. м. Київ' }, { hint: 'Населений пункт, де складено ТТН' }),
                field('load_point', null, { maxlength: 500 }, { wide: false }),
                field('unload_point', null, { maxlength: 500 }),
                field('readdressing', 'Переадресування вантажу (додатковий реквізит)', { maxlength: 500 })),
            ...cargoSection(),
            ...operationsSection(),
            h('h2', { class: 'form-section' }, 'Підписи'),
            h('div', { class: 'kpd-grid' },
                field('received_by', 'Отримав водій / експедитор (ПІБ, посада)', { maxlength: 300 }),
                field('released_by', 'Здав — відповідальна особа вантажовідправника (ПІБ, посада)', { maxlength: 300 }),
                field('accepted_by', 'Прийняв — відповідальна особа вантажоодержувача (ПІБ, посада)', { maxlength: 300 })));
        paint();
    }

    async function prefill() {
        if (!clientSel.value) {
            clear(body, h('p', { class: 'muted' }, 'Оберіть клієнта — підставимо замовника, авто й маршрут рейсу.'));
            return;
        }
        clear(body, spinner('Підставляємо дані…'));
        const { data, error } = await app.supabase.rpc('kp_ttn_prefill', {
            p_calculation: route.calc && clientSel.value === route.client ? route.calc : null, p_client: clientSel.value, p_vehicle: null,
        });
        if (error) return clear(body, notice(ttnErrorText(error)));
        pre = data;
        const keepDate = docDate.value;
        d = ttnFromPrefill(pre);
        d.doc_date = keepDate;
        touched.gross = false;
        touched.lineGross = false;
        if (!pre.vehicle && pre.vehicle_id === null && vehicles.length === 1) applyVehicle(vehicles[0]);
        numberHint.textContent = 'Порожньо — автоматичний номер (наступний: ' + (pre.prefix || '') + pre.next_number + '). Можна вказати свій, якщо він вільний.';
        if (pre.calculation) {
            clear(message, notice('Рейс ' + fmtDate(pre.calculation.trip_date) + ': ' + [pre.calculation.route_from, pre.calculation.route_to].filter(Boolean).join(' — ')
                + ((pre.vehicles || []).length > 1 ? '. У рейсі кілька авто — на кожне можна виписати окрему ТТН (оберіть авто нижче).' : ''), 'info'));
        }
        drawBody();
    }

    async function loadNextNumber() {
        const { data, error } = await app.supabase.rpc('kp_ttn_next_number', { p_doc_date: docDate.value || today });
        if (!error) numberHint.textContent = 'Порожньо — автоматичний номер (наступний: ' + ((pre && pre.prefix) || '') + data + '). Можна вказати свій, якщо він вільний.';
    }

    function focusField(path) {
        const f = fields[path];
        if (f) {
            f.input.focus();
            f.wrap.scrollIntoView({ block: 'center' });
        }
    }

    const form = h('form', {
        class: 'card kpd-form kpt-form', novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            clear(message);
            if (!clientSel.value) return clear(message, notice('Оберіть клієнта (замовника).'));
            tried = true;
            const errors = paint();
            drawBody();
            const keys = Object.keys(errors);
            if (keys.length) {
                clear(message, notice('Заповніть обовʼязкові поля й виправте помилки (' + keys.length + '): ' + keys.slice(0, 4).map((k) => errors[k]).join('; ') + (keys.length > 4 ? '…' : '')));
                focusField(keys.find((k) => fields[k]) || keys[0]);
                return;
            }
            if (number.value && !(Number(number.value) >= 1 && Number.isInteger(Number(number.value)))) return clear(message, notice('Номер — ціле число від 1.'));
            submit.disabled = true;
            const { id, error } = await createTtn(app, {
                p_client: clientSel.value,
                p_doc_date: docDate.value,
                p_number: number.value ? Number(number.value) : null,
                p_data: ttnPayload(d),
                p_calculation: pre && pre.calculation ? pre.calculation.id : null,
            }, callKpApi);
            submit.disabled = false;
            if (error) {
                const bad = ttnErrorField(error);
                clear(message, notice(ttnErrorText(error)));
                if (bad) focusField(bad.field);
                return;
            }
            toast('ТТН створено');
            app.go('#/docs/ttn/' + id);
        },
    },
    h('div', { class: 'kpd-grid' },
        h('div', { class: 'field kpr-wide' }, h('label', { for: 't-client' }, 'Клієнт (замовник)', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')), clientSel),
        h('div', { class: 'field' }, h('label', { for: 't-date' }, 'Дата складання'), docDate),
        h('div', { class: 'field' }, h('label', { for: 't-number' }, 'Номер'), number, numberHint)),
    message,
    body,
    h('p', { class: 'muted small' }, h('span', { class: 'req' }, '*'), ' — обовʼязкові реквізити ст. 48 Закону «Про автомобільний транспорт». Решту полів форми № 1-ТН можна лишити порожніми — у PDF буде прочерк.'),
    h('div', { class: 'actions kpr-sticky' }, submit, h('a', { class: 'btn btn-ghost', href: '#/docs' }, 'Скасувати')));

    clientSel.addEventListener('change', prefill);
    docDate.addEventListener('change', loadNextNumber);
    prefill();
    return h('div', null,
        h('a', { class: 'back', href: '#/docs' }, '← До документів'),
        h('h2', null, 'Товарно-транспортна накладна (форма № 1-ТН) — нова'),
        form);
}
