// Створення рахунку або акта (окремі документи, кожен — зі своїм номером). З рейсу (#/docs/new/<вид>/<клієнт>/<рейс>)
// або з клієнта за період (кілька рейсів). Рядки можна правити; суми в формі — попередній показ, рахує сервер.
import { h, clear, spinner, notice, toast, svgEl } from '../ui.js';
import { fmtDate, kyivDate, monthRange } from '../lib/format.js';
import { callKpApi } from '../lib/gps-client.js';
import {
    CURRENCIES, DOC_TITLES, VAT_MODES, createDocument, docErrorText, dueDateFor, fmtAmount, linesPayload, previewTotals, rateProblem,
    tripRoute, tripsToLines, validateLines, docNumberText, MAX_LINES,
} from '../lib/docs.js';
import { showError } from './docs.js';
import { totalRows } from './docs-totals.js';
import { docsBackHash } from '../lib/docs-requests.js';
import { requestPicker, requestDocsNotice } from './docs-request-picker.js';
import { linkClientPanel } from './docs-link-client.js';

// Смітничок «Видалити рядок» (16px, stroke = currentColor).
function trashIcon() {
    return svgEl('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        svgEl('path', { d: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5' }));
}

function shiftDays(iso, days) {
    return new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

export function renderDocForm(app, access, route) {
    const kind = route.kind === 'act' ? 'act' : 'invoice';
    const root = h('div', null, spinner());

    const load = async () => {
        const [req, cl] = await Promise.all([
            app.supabase.rpc('kp_requisites_get'),
            app.supabase.from('clients').select('id, name, archived_at, payment_terms_days, contract_no, contract_date').order('name', { ascending: true }).limit(2000),
        ]);
        if (req.error) return showError(app, root, req.error);
        // Адреса з заявки без клієнта (#/docs/new/act/calc/<id>): клієнт береться із заявки; якщо його немає — обирається вручну.
        if (route.calc && !route.client) {
            const link = await app.supabase.from('calculation_clients').select('client_id').eq('calculation_id', route.calc).limit(1);
            route = { ...route, client: link.data && link.data[0] ? link.data[0].client_id : null };
        }
        const requisites = (req.data || [])[0];
        if (!requisites || (!requisites.edrpou && !requisites.ipn) || (kind === 'invoice' && !requisites.iban)) {
            clear(root, notice(requisites
                ? 'Для рахунку потрібен IBAN компанії, для будь-якого документа — ЄДРПОУ або ІПН. Доповніть реквізити.'
                : 'Спершу заповніть реквізити компанії — вони потрапляють у кожен документ.', 'info'),
            access.isOwner ? h('a', { class: 'btn btn-primary', href: '#/docs/requisites' }, 'Заповнити реквізити')
                : h('p', { class: 'muted' }, 'Реквізити заповнює директор компанії.'));
            return;
        }
        if (route.calc && !route.client) {
            clear(root, h('a', { class: 'back', href: docsBackHash(kind) }, '← До документів'),
                linkClientPanel(app, { kind, calcId: route.calc, onLinked: (client) => { route = { ...route, client }; clear(root, spinner()); load(); } }));
            return;
        }
        const clients = (cl.data || []).filter((c) => !c.archived_at);
        clear(root, buildForm(app, kind, route, requisites, clients));
    };
    load();
    return root;
}

function buildForm(app, kind, route, requisites, clients) {
    const today = kyivDate();
    const vatPayer = requisites.vat_payer === true;
    const state = { lines: [], vatMode: requisites.default_vat_mode || 'net', dueTouched: false, trips: [] };
    const message = h('div', { 'aria-live': 'polite' });

    const clientSel = h('select', { id: 'd-client', required: true },
        h('option', { value: '' }, '— оберіть клієнта —'),
        clients.map((c) => h('option', { value: c.id, selected: c.id === route.client }, c.name)));
    const docDate = h('input', { type: 'date', id: 'd-date', value: today, max: shiftDays(today, 1) });
    const number = h('input', { type: 'number', id: 'd-number', min: 1, step: 1, inputmode: 'numeric', placeholder: 'авто' });
    const numberHint = h('div', { class: 'hint', id: 'd-number-hint' });
    const currency = h('select', { id: 'd-currency' }, CURRENCIES.map((c) => h('option', { value: c, selected: c === (requisites.default_currency || 'UAH') }, c)));
    const rate = h('input', { type: 'text', id: 'd-rate', inputmode: 'decimal', placeholder: '41,234567', autocomplete: 'off' });
    const rateDate = h('input', { type: 'date', id: 'd-rate-date' });
    const rateHint = h('div', { class: 'hint', 'aria-live': 'polite' });
    const rateBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => fetchRate(true) }, 'Оновити курс НБУ');
    const rateRow = h('div', { class: 'kpd-rate' },
        h('div', { class: 'field' }, h('label', { for: 'd-rate' }, 'Курс НБУ, грн'), rate),
        h('div', { class: 'field' }, h('label', { for: 'd-rate-date' }, 'Дата курсу'), rateDate),
        h('div', { class: 'field kpd-rate-btn' }, h('span', { class: 'kpr-label' }, ' '), rateBtn),
        rateHint);
    const due = h('input', { type: 'date', id: 'd-due', oninput: () => { state.dueTouched = true; } });
    const parentSel = h('select', { id: 'd-parent' }, h('option', { value: '' }, '— без рахунку —'));
    const vatBox = h('div', { class: 'segmented kpd-vat', role: 'radiogroup', 'aria-label': 'Режим ПДВ' });
    const linesBox = h('div', { class: 'kpd-lines' });
    const totalsBox = h('div', { class: 'kpr-totals kpd-totals', 'aria-live': 'polite' });
    const tripsBox = h('div', { class: 'kpd-trips', 'data-no-dirty': '' }); // вибір рейсів для додавання — ще не зміна документа
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, kind === 'invoice' ? 'Створити рахунок' : 'Створити акт');

    const range = route.calc ? { from: shiftDays(today, -700), to: shiftDays(today, 30) } : monthRange(today);
    const tripsFrom = h('input', { type: 'date', value: range.from, 'aria-label': 'Рейси з' });
    const tripsTo = h('input', { type: 'date', value: range.to, 'aria-label': 'Рейси по' });

    const clientById = (id) => clients.find((c) => c.id === id) || null;

    function drawVat() {
        clear(vatBox, VAT_MODES.map((m) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(m.value === state.vatMode), class: m.value === state.vatMode ? 'is-on' : '',
            onclick: () => { state.vatMode = m.value; drawVat(); drawTotals(); },
        }, m.short || m.label)));
    }

    function drawTotals() {
        const t = previewTotals(state.lines, { vatPayer, vatMode: state.vatMode });
        const cur = currency.value;
        if (!Number.isFinite(t.total)) {
            clear(totalsBox, h('span', { class: 'hint hint-error' }, 'Перевірте кількість і ціну в рядках'));
            return;
        }
        // Підсумки окремими рядками праворуч: підпис — значення (значення не злипається з підписом).
        clear(totalsBox,
            totalRows({ vat: vatPayer, subtotal: fmtAmount(t.subtotal, cur), vatAmount: fmtAmount(t.vat, cur), total: fmtAmount(t.total, cur) }),
            h('div', { class: 'kpd-total-note muted small' }, 'Попередньо; остаточні суми рахує сервер'));
    }

    // Рядок документа — рядок таблиці (Найменування | Од. | К-сть | Ціна | Сума | смітничок); підказка про рейс — дрібним рядком під ним.
    function lineRow(line, index) {
        const amount = h('span', { class: 'mono kpd-amount' });
        const paint = () => {
            const t = previewTotals([line], { vatPayer: false });
            amount.textContent = Number.isFinite(t.total) ? fmtAmount(t.total, currency.value) : '—';
        };
        const cell = (cls, ...children) => h('td', { class: cls }, ...children);
        const field = (key, attrs) => h('input', Object.assign({
            value: line[key] === undefined || line[key] === null ? '' : String(line[key]), autocomplete: 'off',
            oninput: (event) => { line[key] = event.target.value; paint(); drawTotals(); },
        }, attrs));
        paint();
        const main = h('tr', { class: 'kpd-row' },
            cell('kpd-c-title', field('title', { type: 'text', maxlength: 500, 'aria-label': 'Найменування, рядок ' + (index + 1), class: 'kpd-title', placeholder: 'Найменування послуги' })),
            cell('kpd-c-unit', field('unit', { type: 'text', maxlength: 20, 'aria-label': 'Одиниця', placeholder: 'послуга' })),
            cell('kpd-c-num', field('qty', { type: 'text', inputmode: 'decimal', 'aria-label': 'Кількість', placeholder: '1' })),
            cell('kpd-c-num', field('price', { type: 'text', inputmode: 'decimal', 'aria-label': 'Ціна', placeholder: '0,00' })),
            cell('kpd-c-sum', amount),
            cell('kpd-c-del', h('button', {
                type: 'button', class: 'btn btn-ghost kpd-del', title: 'Видалити рядок', 'aria-label': 'Видалити рядок ' + (index + 1),
                onclick: () => { state.lines.splice(index, 1); drawLines(); },
            }, trashIcon())));
        if (!line.calculation_id) return [main];
        return [main, h('tr', { class: 'kpd-line-hint' },
            h('td', { colspan: 6 }, h('span', { class: 'hint kpd-link-hint' }, 'Рядок повʼязаний з рейсом (рейс не потрапить в інший активний документ цього типу)')))];
    }

    function drawLines() {
        clear(linesBox,
            state.lines.length ? h('div', { class: 'table-wrap kpd-lines-wrap' }, h('table', { class: 'table kpd-lines-table' },
                h('thead', null, h('tr', { class: 'kpd-line-head' },
                    h('th', { class: 'kpd-c-title' }, 'Найменування'), h('th', { class: 'kpd-c-unit' }, 'Од.'), h('th', { class: 'kpd-c-num' }, 'К-сть'),
                    h('th', { class: 'kpd-c-num' }, 'Ціна'), h('th', { class: 'kpd-c-sum' }, 'Сума'), h('th', { class: 'kpd-c-del', 'aria-label': 'Дії' }))),
                h('tbody', null, state.lines.flatMap(lineRow))))
                : h('p', { class: 'muted' }, 'Рядків ще немає — додайте рейси нижче або рядок вручну.'),
            h('button', {
                type: 'button', class: 'btn btn-sm', disabled: state.lines.length >= MAX_LINES,
                onclick: () => { state.lines.push({ title: '', unit: 'послуга', qty: '1', price: '' }); drawLines(); },
            }, '+ Рядок'));
        drawTotals();
    }

    function updateDue() {
        if (kind !== 'invoice' || state.dueTouched) return;
        const c = clientById(clientSel.value);
        due.value = dueDateFor(docDate.value, c ? c.payment_terms_days : null);
    }

    async function loadNextNumber() {
        const { data, error } = await app.supabase.rpc('kp_doc_next_number', { p_kind: kind, p_doc_date: docDate.value || today });
        numberHint.textContent = error ? '' : 'Порожньо — автоматичний номер (наступний: ' + (requisites[kind + '_prefix'] || '') + data + '). Можна вказати свій, якщо він вільний.';
    }

    async function fetchRate(manual) {
        const cur = currency.value;
        rateRow.hidden = cur === 'UAH';
        drawTotals();
        if (cur === 'UAH') return;
        const date = docDate.value && docDate.value <= today ? docDate.value : today;
        rateHint.className = 'hint';
        rateHint.textContent = 'Завантажуємо курс НБУ…';
        const out = await callKpApi(app, '/api/docs/rate', { currency: cur, date });
        if (cur !== currency.value) return;
        if (!out.ok) {
            rateHint.className = 'hint hint-warn';
            rateHint.textContent = (out.error || 'Курс НБУ недоступний') + ' Введіть курс і дату вручну.';
            return;
        }
        rate.value = String(out.rate).replace('.', ',');
        rateDate.value = out.rate_date || date;
        rateHint.textContent = 'Курс НБУ на ' + fmtDate(rateDate.value) + ': 1 ' + cur + ' = ' + rate.value + ' грн' + (manual ? ' (оновлено)' : '') + '. Можна виправити вручну.';
    }

    async function loadParents() {
        if (kind !== 'act') return;
        clear(parentSel, h('option', { value: '' }, '— без рахунку —'));
        if (!clientSel.value) return;
        const { data } = await app.supabase.rpc('kp_doc_list', {
            p_kind: 'invoice', p_from: shiftDays(today, -700), p_to: shiftDays(today, 1), p_client: clientSel.value, p_status: null,
        });
        for (const d of (data || []).filter((x) => x.status === 'issued')) {
            parentSel.append(h('option', { value: d.id }, '№ ' + docNumberText(d) + ' від ' + fmtDate(d.doc_date) + ' — ' + fmtAmount(d.total, d.currency)));
        }
    }

    async function copyFromParent() {
        if (!parentSel.value || state.lines.length) return;
        const { data, error } = await app.supabase.rpc('kp_doc_get', { p_doc: parentSel.value });
        if (error || !data) return;
        state.lines = (data.lines || []).map((l) => ({ title: l.title, unit: l.unit, qty: String(l.qty), price: String(l.price), calculation_id: l.calculation_id }));
        if (CURRENCIES.includes(data.currency) && data.currency !== currency.value) {
            currency.value = data.currency;
            fetchRate(false);
        }
        drawLines();
        toast('Рядки скопійовано з рахунку');
    }

    async function loadTrips() {
        if (!clientSel.value) {
            clear(tripsBox, h('p', { class: 'muted' }, 'Оберіть клієнта, щоб побачити його рейси.'));
            return;
        }
        clear(tripsBox, spinner('Шукаємо рейси клієнта…'));
        const { data, error } = await app.supabase.rpc('kp_doc_trips_for_client', {
            p_client: clientSel.value, p_from: tripsFrom.value, p_to: tripsTo.value, p_kind: kind,
        });
        if (error) return clear(tripsBox, notice(docErrorText(error)));
        state.trips = data || [];
        drawTrips();
        if (route.calc && !state.calcUsed) {
            state.calcUsed = true;
            const trip = state.trips.find((t) => t.calculation_id === route.calc);
            if (trip) addTrips([trip]);
            else clear(message, notice('Цей рейс уже є в активному документі такого типу або не належить клієнту.', 'info'));
        }
    }

    // Ціни рейсів — у гривні; для документа у валюті перераховуємо за курсом із форми (його можна виправити).
    function addTrips(trips) {
        const have = new Set(state.lines.map((l) => l.calculation_id).filter(Boolean));
        const fresh = trips.filter((t) => !have.has(t.calculation_id));
        const cur = currency.value;
        const r = Number(rate.value.replace(',', '.'));
        const convert = cur !== 'UAH' && r > 0;
        if (cur !== 'UAH' && fresh.length) {
            toast(convert ? 'Ціни рейсів перераховано з гривні за курсом ' + rate.value : 'Ціни рейсів у гривні — вкажіть курс або виправте ціни', convert ? 'ok' : 'error');
        }
        state.lines.push(...tripsToLines(fresh).map((l) => ({
            ...l, qty: String(l.qty), price: String(convert ? Math.round((l.price / r) * 100) / 100 : l.price),
        })));
        drawLines();
        drawTrips();
    }

    function drawTrips() {
        const used = new Set(state.lines.map((l) => l.calculation_id).filter(Boolean));
        const rows = state.trips.filter((t) => !used.has(t.calculation_id));
        if (!state.trips.length) {
            clear(tripsBox, h('p', { class: 'muted' }, 'За цей період немає рейсів клієнта, ще не включених у ' + (kind === 'act' ? 'акт.' : 'рахунок.')));
            return;
        }
        if (!rows.length) {
            clear(tripsBox, h('p', { class: 'muted' }, 'Усі рейси періоду вже в рядках документа.'));
            return;
        }
        const boxes = new Map();
        const addBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled: true }, 'Додати вибрані');
        const sync = () => {
            const n = [...boxes.values()].filter((b) => b.checked).length;
            addBtn.disabled = n === 0;
            addBtn.textContent = n ? 'Додати вибрані (' + n + ')' : 'Додати вибрані';
        };
        addBtn.addEventListener('click', () => addTrips(rows.filter((t) => boxes.get(t.calculation_id).checked)));
        const all = h('input', { type: 'checkbox', 'aria-label': 'Вибрати всі рейси', onchange: (e) => { for (const b of boxes.values()) b.checked = e.target.checked; sync(); } });
        clear(tripsBox,
            h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
                h('thead', null, h('tr', null, h('th', null, all), h('th', null, 'Дата'), h('th', null, 'Маршрут'), h('th', null, 'Ціна'), h('th', null, 'Джерело'))),
                h('tbody', null, rows.map((t) => {
                    const box = h('input', { type: 'checkbox', 'aria-label': 'Рейс ' + tripRoute(t) + ' ' + fmtDate(t.trip_date), onchange: sync });
                    boxes.set(t.calculation_id, box);
                    return h('tr', null,
                        h('td', { 'data-label': '' }, h('label', { class: 'check' }, box, ' Вибрати')),
                        h('td', { 'data-label': 'Дата' }, fmtDate(t.trip_date)),
                        h('td', { 'data-label': 'Маршрут' }, tripRoute(t)),
                        h('td', { 'data-label': 'Ціна', class: 'mono' }, fmtAmount(t.price, 'UAH')),
                        h('td', { 'data-label': 'Джерело' }, t.price_source === 'fact' ? 'факт' : 'план'));
                })))),
            h('div', { class: 'actions' }, addBtn));
        sync();
    }

    const form = h('form', {
        class: 'card kpd-form', novalidate: true,
        onsubmit: async (event) => {
            event.preventDefault();
            clear(message);
            if (!clientSel.value) return clear(message, notice('Оберіть клієнта.'));
            const lineErrors = validateLines(state.lines);
            if (Object.keys(lineErrors).length) {
                const first = Object.entries(lineErrors)[0];
                return clear(message, notice(first[0] === 'all' ? first[1] : 'Рядок ' + (Number(first[0]) + 1) + ': ' + first[1]));
            }
            const cur = currency.value;
            const rateText = rate.value.replace(',', '.').trim();
            const problem = rateProblem(cur, rateText, rateDate.value, docDate.value);
            if (problem) return clear(message, notice(problem));
            if (number.value && !(Number(number.value) >= 1 && Number.isInteger(Number(number.value)))) return clear(message, notice('Номер — ціле число від 1.'));
            submit.disabled = true;
            const { id, errorText } = await createDocument(app, {
                p_kind: kind,
                p_client: clientSel.value,
                p_doc_date: docDate.value,
                p_currency: cur,
                p_number: number.value ? Number(number.value) : null,
                p_lines: linesPayload(state.lines),
                p_parent: kind === 'act' && parentSel.value ? parentSel.value : null,
                p_due_date: kind === 'invoice' && state.dueTouched && due.value ? due.value : null,
                p_vat_mode: vatPayer ? state.vatMode : null,
                p_rate: cur === 'UAH' ? null : Number(rateText),
                p_rate_date: cur === 'UAH' ? null : rateDate.value,
            }, callKpApi);
            submit.disabled = false;
            if (errorText) return clear(message, notice(errorText));
            toast((kind === 'invoice' ? 'Рахунок' : 'Акт') + ' створено');
            app.go('#/docs/' + id);
        },
    },
    h('div', { class: 'field kpr-wide' }, requestPicker(app, kind, { current: route.calc }), requestDocsNotice(app, kind, route.calc)),
    h('div', { class: 'kpd-grid' },
        h('div', { class: 'field kpr-wide' }, h('label', { for: 'd-client' }, 'Клієнт', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')), clientSel),
        h('div', { class: 'field' }, h('label', { for: 'd-date' }, 'Дата документа'), docDate),
        h('div', { class: 'field' }, h('label', { for: 'd-number' }, 'Номер'), number, numberHint),
        h('div', { class: 'field' }, h('label', { for: 'd-currency' }, 'Валюта'), currency),
        kind === 'invoice'
            ? h('div', { class: 'field' }, h('label', { for: 'd-due' }, 'Оплатити до'), due, h('div', { class: 'hint' }, 'За замовчуванням — строк оплати клієнта (5 днів, якщо не вказано).'))
            : h('div', { class: 'field' }, h('label', { for: 'd-parent' }, 'До рахунку (необовʼязково)'), parentSel)),
    rateRow,
    vatPayer ? h('div', { class: 'field kpd-vat-field' }, h('span', { class: 'kpr-label' }, 'ПДВ 20 %'), vatBox) : h('p', { class: 'muted small' }, 'Компанія не є платником ПДВ — документ без ПДВ.'),
    h('h2', { class: 'form-section' }, 'Рядки документа'),
    linesBox,
    totalsBox,
    h('h2', { class: 'form-section' }, 'Рейси клієнта'),
    h('div', { class: 'toolbar kpd-trips-filter', 'data-no-dirty': '' },
        h('label', { class: 'kpd-f' }, 'з', tripsFrom), h('label', { class: 'kpd-f' }, 'по', tripsTo),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: loadTrips }, 'Показати рейси')),
    tripsBox,
    message,
    h('div', { class: 'actions kpr-sticky' }, submit, h('a', { class: 'btn btn-ghost', href: docsBackHash(kind) }, 'Скасувати')));

    clientSel.addEventListener('change', () => { updateDue(); loadTrips(); loadParents(); });
    docDate.addEventListener('change', () => { updateDue(); loadNextNumber(); fetchRate(false); });
    currency.addEventListener('change', () => { drawLines(); fetchRate(false); });
    parentSel.addEventListener('change', copyFromParent);

    drawVat();
    drawLines();
    updateDue();
    loadNextNumber();
    fetchRate(false);
    loadTrips();
    loadParents();
    return h('div', null,
        h('a', { class: 'back', href: docsBackHash(kind) }, '← До документів'),
        h('h2', null, (DOC_TITLES[kind] || 'Документ') + ' — новий'),
        form);
}
