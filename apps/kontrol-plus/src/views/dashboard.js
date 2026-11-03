// Дашборд «Контроль+» (PR 4 з 5): KPI за період, виручка по днях (SVG), останні заявки, прострочені оплати, документи без акта / підпису.
// Лише наявні RPC під RLS (DASHBOARD_RPCS у lib/dashboard.js); нових міграцій і функцій немає. Текст — лише через h() / textContent.
// Кожна картка вантажиться окремо: помилка однієї RPC не валить сторінку. Права рахує сервер (RLS / kp_org_id): що повернув — те й показуємо.
import { h, svgEl, clear, uniqueId } from '../ui.js';
import { fmtDate, fmtMoney, kyivDate, STATUS_LABELS, daysBetween } from '../lib/format.js';
import { fmtAmount, isMissingFeature } from '../lib/docs.js';
import { errorText, isPlanError } from '../lib/errors.js';
import {
    LIST_ROWS, MAX_CUSTOM_DAYS, MAX_PAGES, PAGE_SIZE, PERIODS, aggregateByDay, chartGeometry, dashboardAccess, delta, docGaps, fmtDelta, fmtShort, mainCurrency,
    overdueDebts, periodRange, prevRange, readPeriod, recentRequests, registryFilters, sumDebts, writePeriod,
} from '../lib/dashboard.js';

const storage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

export const READ_ONLY_HINT = 'Лише перегляд: ваша роль або тариф не дозволяють створювати. Тариф — на trip-control.com.';

// rpc без винятків: { data, error }.
async function call(app, name, args) {
    try {
        const { data, error } = await app.supabase.rpc(name, args);
        return { data: error ? null : data, error: error || null };
    } catch (error) {
        return { data: null, error };
    }
}

const mono = (text, cls) => h('span', { class: 'kpd-mono' + (cls ? ' ' + cls : '') }, text);
const skeleton = (lines = 3) => h('div', { class: 'kpd-skel', 'aria-hidden': 'true' }, Array.from({ length: lines }, () => h('i', null)));

function cardShell(title, extra) {
    const body = h('div', { class: 'kpd-card-body' }, skeleton());
    const head = h('div', { class: 'kpd-card-head' }, h('h2', null, title), extra || null);
    return { el: h('section', { class: 'kpd-card', 'aria-busy': 'true' }, head, body), body, head };
}

function softError(error) {
    return h('p', { class: 'kpd-soft-error', role: 'status' }, isMissingFeature(error) ? 'Ця частина ще не ввімкнена для вашої компанії.' : errorText(error));
}

function empty(text, action) {
    return h('div', { class: 'kpd-empty' }, h('p', null, text), action || null);
}

export function renderDashboard(app, deps = {}) {
    const store = deps.storage === undefined ? storage() : deps.storage;
    const today = () => (deps.today ? deps.today() : kyivDate());
    const { finance: fin, canWrite } = dashboardAccess(app.context);
    const openSite = (view) => () => { if (typeof app.openSite === 'function') app.openSite(view); };
    let selection = readPeriod(store);
    let ticket = 0;
    let destroyed = false;
    let observer = null;
    if (typeof app.onCleanup === 'function') app.onCleanup(() => { destroyed = true; if (observer) observer.disconnect(); });

    // --- шапка: період ---
    const fromIn = h('input', { type: 'date', 'aria-label': 'Початок періоду', class: 'kpd-date' });
    const toIn = h('input', { type: 'date', 'aria-label': 'Кінець періоду', class: 'kpd-date' });
    const customBox = h('span', { class: 'kpd-custom' }, fromIn, ' – ', toIn);
    const periodBox = h('div', { class: 'kpd-periods', role: 'radiogroup', 'aria-label': 'Період' });
    const rangeNote = h('span', { class: 'kpd-range kpd-mono' });
    const periodError = h('p', { class: 'kpd-soft-error', role: 'alert', hidden: true });

    function drawPeriods() {
        clear(periodBox, PERIODS.map((p) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(p.value === selection.kind), class: 'kpd-chip' + (p.value === selection.kind ? ' is-on' : ''),
            onclick: () => choose(p.value),
        }, p.label)));
        customBox.hidden = selection.kind !== 'custom';
        const r = periodRange(selection, today());
        fromIn.value = r.from;
        toIn.value = r.to;
        rangeNote.textContent = r.from === r.to ? fmtDate(r.from) : fmtDate(r.from) + ' – ' + fmtDate(r.to);
    }
    function choose(kind) {
        if (kind === 'custom') {
            const r = periodRange(selection, today());
            selection = { kind: 'custom', from: r.from, to: r.to };
        } else selection = { kind };
        periodError.hidden = true;
        writePeriod(store, selection);
        drawPeriods();
        load();
    }
    function onCustom() {
        const from = fromIn.value;
        const to = toIn.value;
        if (!from || !to || from > to || daysBetween(from, to) >= MAX_CUSTOM_DAYS) {
            periodError.textContent = 'Перевірте період: «з» не пізніше «по», не довше ' + MAX_CUSTOM_DAYS + ' днів.';
            periodError.hidden = false;
            return;
        }
        periodError.hidden = true;
        selection = { kind: 'custom', from, to };
        writePeriod(store, selection);
        drawPeriods();
        load();
    }
    fromIn.addEventListener('change', onCustom);
    toIn.addEventListener('change', onCustom);

    // --- швидкі дії (вікна PR 3 відкриває hash-маршрут; на вузькому екрані — звичайний перехід, як і раніше) ---
    const disabledAttrs = canWrite ? {} : { disabled: true, title: READ_ONLY_HINT, 'aria-disabled': 'true' };
    const quick = h('div', { class: 'kpd-quick', role: 'group', 'aria-label': 'Швидкі дії' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', id: 'kpd-new-request', onclick: openSite('calc'), ...disabledAttrs }, 'Нова заявка'),
        h('button', { type: 'button', class: 'btn btn-sm', id: 'kpd-calc', onclick: openSite('calc') }, 'Розрахунок рейсу'),
        h('button', { type: 'button', class: 'btn btn-sm', id: 'kpd-registry', onclick: openSite('registry') }, 'Відкрити реєстр'),
        fin && canWrite ? h('a', { class: 'btn btn-sm', id: 'kpd-new-invoice', href: '#/docs/new/invoice' }, 'Новий рахунок') : null);

    // --- KPI ---
    const kpi = {};
    const kpiDefs = [
        ['revenue', 'Виручка'], ['margin', 'Маржа'], ['requests', 'Заявок'], ...(fin ? [['debt', 'Дебіторка']] : []), ['active', 'Рейси в роботі'],
    ];
    const kpis = h('div', { class: 'kpd-kpis' }, kpiDefs.map(([key, label]) => {
        const value = h('div', { class: 'kpd-kpi-value' }, skeleton(1));
        const sub = h('div', { class: 'kpd-kpi-sub' });
        const dl = h('div', { class: 'kpd-kpi-delta' });
        kpi[key] = { value, sub, dl, el: h('article', { class: 'kpd-kpi', 'data-kpi': key, 'aria-busy': 'true' }, h('div', { class: 'kpd-kpi-label' }, label), value, sub, dl) };
        return kpi[key].el;
    }));
    function paint(key, { value, sub, d, error, invert }) {
        const k = kpi[key];
        k.el.removeAttribute('aria-busy');
        if (error) {
            clear(k.value, h('span', { class: 'kpd-mono' }, '—'));
            clear(k.sub, softError(error));
            clear(k.dl);
            return;
        }
        clear(k.value, mono(value));
        clear(k.sub, sub || '');
        clear(k.dl);
        if (d) {
            // Для дебіторки зростання — погано, тож колір інвертується.
            const good = invert ? d.dir === 'down' : d.dir === 'up';
            const bad = invert ? d.dir === 'up' : d.dir === 'down';
            k.dl.append(h('span', { class: 'kpd-mono kpd-delta' + (good ? ' is-good' : bad ? ' is-bad' : '') }, fmtDelta(d)), h('small', null, ' до попереднього періоду'));
        }
    }
    function resetKpis() {
        for (const k of Object.values(kpi)) {
            k.el.setAttribute('aria-busy', 'true');
            clear(k.value, skeleton(1));
            clear(k.sub);
            clear(k.dl);
        }
    }

    // --- картки ---
    const chartCard = cardShell('Виручка по днях');
    chartCard.el.classList.add('kpd-card-chart');
    const recentAll = h('button', { type: 'button', class: 'kpd-all', onclick: openSite('registry') }, 'Усі →');
    const recentCard = cardShell('Останні заявки', recentAll);
    const debtsAll = h('a', { class: 'kpd-all', href: '#/report/debts' }, 'Усі →');
    const debtsCard = fin ? cardShell('Прострочені оплати', debtsAll) : null;
    const docsAll = h('a', { class: 'kpd-all', href: '#/docs/tab/acts' }, 'Усі →');
    const docsCard = fin ? cardShell('Документи без акта / підпису', docsAll) : null;
    const grid = h('div', { class: 'kpd-grid' }, chartCard.el, recentCard.el, debtsCard && debtsCard.el, docsCard && docsCard.el);

    const calcAction = () => h('button', { type: 'button', class: 'btn btn-sm', onclick: openSite('calc'), ...disabledAttrs }, 'Розрахувати рейс');

    // --- графік ---
    let chartState = null; // { agg, note }
    const tip = h('div', { class: 'kpd-tip', role: 'status', hidden: true });
    const chartWrap = h('div', { class: 'kpd-chart' });
    const chartNote = h('p', { class: 'kpd-note' });
    const titleId = uniqueId('kpd-chart');

    function drawChart() {
        if (!chartState) return;
        const { agg } = chartState;
        const width = Math.max(260, Math.round(chartWrap.clientWidth || 640));
        const g = chartGeometry(agg.days, { width, height: width < 480 ? 170 : 210 });
        const show = (b) => {
            tip.hidden = false;
            clear(tip, h('b', { class: 'kpd-mono' }, fmtMoney(b.revenue)), h('small', null, (agg.weekly ? 'Тиждень з ' : '') + fmtDate(b.date) + ' · заявок: ' + b.count));
            const left = Math.min(Math.max(b.cx / g.width, 0.12), 0.88);
            tip.style.left = (left * 100) + '%';
        };
        const hide = () => { tip.hidden = true; };
        const svg = svgEl('svg', { class: 'kpd-svg', viewBox: '0 0 ' + g.width + ' ' + g.height, width: g.width, height: g.height, role: 'group', 'aria-labelledby': titleId },
            svgEl('title', { id: titleId }, 'Виручка по днях'),
            g.ticks.map((t) => [
                svgEl('line', { class: 'kpd-grid-line', x1: g.padLeft, x2: g.width - 8, y1: t.y, y2: t.y }),
                svgEl('text', { class: 'kpd-axis', x: g.padLeft - 6, y: t.y + 3, 'text-anchor': 'end' }, fmtShort(t.value)),
            ]),
            g.bars.map((b) => {
                const label = fmtDate(b.date) + ': ' + fmtMoney(b.revenue) + ', заявок ' + b.count;
                const rect = svgEl('rect', {
                    class: 'kpd-bar' + (b.revenue > 0 ? '' : ' is-zero'), x: b.x, y: b.revenue > 0 ? Math.min(b.y, g.axisY - 1) : g.axisY - 1, width: b.w, height: Math.max(b.revenue > 0 ? b.h : 1, 1),
                    tabindex: '0', role: 'img', 'aria-label': label, rx: 2,
                });
                rect.addEventListener('mouseenter', () => show(b));
                rect.addEventListener('focus', () => show(b));
                rect.addEventListener('mouseleave', hide);
                rect.addEventListener('blur', hide);
                return rect;
            }),
            g.labels.map((l) => svgEl('text', { class: 'kpd-axis', x: l.x, y: g.height - 6, 'text-anchor': 'middle' }, fmtDate(l.date).slice(0, 5))));
        clear(chartWrap, svg, tip);
    }

    function paintChart(agg, info) {
        chartCard.el.removeAttribute('aria-busy');
        if (!agg.count) {
            chartState = null;
            clear(chartCard.body, empty('Ще немає заявок за період.', canWrite ? calcAction() : null));
            return;
        }
        chartState = { agg };
        clear(chartCard.body, chartWrap, chartNote);
        chartNote.textContent = info.truncated
            ? 'Агреговано за перші ' + info.fetched + ' із ' + info.total + ' заявок періоду (новіші першими). Точніше — серверна агрегація (див. опції в описі PR).'
            : 'План виручки без скасованих заявок; день — дата рейсу (за Києвом). Разом: ' + fmtMoney(agg.total) + '.';
        drawChart();
    }

    // --- списки ---
    function requestRow(r) {
        return h('li', null, h('a', { class: 'kpd-row', href: '#/requests/' + encodeURIComponent(r.id) },
            mono(r.registry_no || '—', 'kpd-no'),
            h('span', { class: 'kpd-row-main' }, h('b', null, r.client_name || r.name || '—'), h('small', null, [r.route_from, r.route_to].filter(Boolean).join(' → ') || fmtDate(r.trip_date))),
            h('span', { class: 'kpd-row-side' }, mono(fmtMoney(r.revenue)), h('small', null, STATUS_LABELS[r.status] || r.status))));
    }
    function paintRecent(rows) {
        recentCard.el.removeAttribute('aria-busy');
        const list = recentRequests(rows);
        clear(recentCard.body, list.length ? h('ul', { class: 'kpd-list' }, list.map(requestRow)) : empty('Ще немає заявок за період.', canWrite ? calcAction() : null));
    }
    function paintDebts(rows) {
        debtsCard.el.removeAttribute('aria-busy');
        const list = overdueDebts(rows);
        clear(debtsCard.body, list.length ? h('ul', { class: 'kpd-list' }, list.map((r) => h('li', null, h('a', { class: 'kpd-row', href: '#/clients/' + encodeURIComponent(r.client_id) },
            h('span', { class: 'kpd-row-main' }, h('b', null, r.client_name), h('small', null, r.oldest_due ? 'від ' + fmtDate(r.oldest_due) : '')),
            h('span', { class: 'kpd-row-side' }, mono(fmtAmount(r.overdue, r.currency), 'is-bad'), h('small', null, (r.overdue_days || 0) + ' дн.'))))))
            : empty('Прострочених оплат немає.'));
    }
    function paintGaps(gaps) {
        docsCard.el.removeAttribute('aria-busy');
        clear(docsCard.body, gaps.length ? h('ul', { class: 'kpd-list' }, gaps.map(({ request: r, problems }) => h('li', null, h('a', { class: 'kpd-row', href: '#/requests/' + encodeURIComponent(r.id) },
            mono(r.registry_no || '—', 'kpd-no'),
            h('span', { class: 'kpd-row-main' }, h('b', null, r.client_name || r.name || '—'), h('small', null, problems.join(' · '))),
            h('span', { class: 'kpd-row-side' }, h('small', null, fmtDate(r.trip_date)))))))
            : empty('Усі заявки періоду з документами.'));
    }
    const failCard = (card, error) => { card.el.removeAttribute('aria-busy'); clear(card.body, softError(error)); };

    // --- завантаження ---
    async function loadRows(range) {
        const rows = [];
        let total = 0;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const res = await call(app, 'registry_list', { p_filters: registryFilters(app.context, range), p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE });
            if (res.error) return { error: res.error, rows, total };
            const chunk = res.data || [];
            if (chunk.length) total = Number(chunk[0].total_count) || total;
            rows.push(...chunk);
            if (chunk.length < PAGE_SIZE || rows.length >= total) break;
        }
        return { rows, total: Math.max(total, rows.length) };
    }

    async function load() {
        const my = ++ticket;
        const stale = () => my !== ticket || destroyed;
        const range = periodRange(selection, today());
        const prev = prevRange(range);
        resetKpis();
        for (const card of [chartCard, recentCard, debtsCard, docsCard]) {
            if (!card) continue;
            card.el.setAttribute('aria-busy', 'true');
            clear(card.body, skeleton());
        }
        const f = (r, extra) => registryFilters(app.context, r, extra);
        const [curT, prevT, activeT, rowsRes, debtNow, debtPrev, unpaid] = await Promise.all([
            call(app, 'registry_totals', { p_filters: f(range) }),
            call(app, 'registry_totals', { p_filters: f(prev) }),
            call(app, 'registry_totals', { p_filters: f(null, { status: ['accepted'] }) }), // прийняті, ще не виконані — без періоду
            loadRows(range),
            fin ? call(app, 'kp_client_debts', { p_on: null }) : null,
            fin ? call(app, 'kp_client_debts', { p_on: prev.to }) : null,
            fin ? call(app, 'kp_unpaid_invoices_count', {}) : null,
        ]);
        if (stale()) return;
        for (const res of [curT, activeT, rowsRes, debtNow]) {
            if (res && res.error && isPlanError(res.error) && typeof app.onPlanLost === 'function') { app.onPlanLost(); return; }
        }

        const t = curT.data && curT.data[0];
        const p = !prevT.error && prevT.data && prevT.data[0];
        const fact = (row, key) => (row ? Number(row[key]) : null);
        if (curT.error || !t) {
            const err = curT.error || new Error('empty');
            ['revenue', 'margin', 'requests'].forEach((key) => paint(key, { error: err }));
        } else {
            paint('revenue', { value: fmtMoney(t.revenue), sub: t.fact_count !== undefined ? 'план по заявках' : '', d: p ? delta(t.revenue, fact(p, 'revenue')) : null });
            const pctOfRevenue = Number(t.revenue) > 0 ? String(Math.round((Number(t.profit_fact) / Number(t.revenue)) * 1000) / 10).replace('.', ',') + '% від виручки' : '';
            paint('margin', {
                value: fmtMoney(t.profit_fact),
                sub: h('span', null, 'план ', mono(fmtMoney(t.profit_plan)), pctOfRevenue ? ' · ' + pctOfRevenue : ''),
                d: p ? delta(t.profit_fact, fact(p, 'profit_fact')) : null,
            });
            paint('requests', {
                value: String(Number(t.total_count) || 0),
                sub: Number(t.cancelled_count) > 0 ? 'скасовано: ' + Number(t.cancelled_count) : '',
                d: p ? delta(t.total_count, fact(p, 'total_count')) : null,
            });
        }
        const a = activeT.data && activeT.data[0];
        if (activeT.error || !a) paint('active', { error: activeT.error || new Error('empty') });
        else paint('active', { value: String(Number(a.total_count) || 0), sub: 'прийняті, ще не виконані' });

        if (fin) {
            if (debtNow.error) paint('debt', { error: debtNow.error });
            else {
                const sums = sumDebts(debtNow.data);
                const cur = mainCurrency(sums);
                const slot = cur ? sums[cur] : { debt: 0, overdue: 0 };
                const prevSums = !debtPrev.error ? sumDebts(debtPrev.data) : null;
                const prevSlot = prevSums ? prevSums[cur || 'UAH'] || { debt: 0 } : null;
                const unpaidN = !unpaid.error && unpaid.data !== null ? Number(unpaid.data) : null;
                const other = Object.keys(sums).length > 1 ? ' + інші валюти' : '';
                paint('debt', {
                    value: fmtAmount(slot.debt, cur || 'UAH') + other,
                    sub: h('span', null, 'прострочено ', mono(fmtAmount(slot.overdue, cur || 'UAH'), slot.overdue > 0 ? 'is-bad' : ''), unpaidN !== null ? ' · неоплачених рахунків: ' + unpaidN : ''),
                    d: prevSlot ? delta(slot.debt, prevSlot.debt) : null,
                    invert: true,
                });
                paintDebts(debtNow.data);
            }
            if (debtNow.error) failCard(debtsCard, debtNow.error);
        }

        // Графік й останні заявки — з одних сторінок registry_list.
        if (rowsRes.error && !rowsRes.rows.length) {
            failCard(chartCard, rowsRes.error);
            failCard(recentCard, rowsRes.error);
            if (docsCard) failCard(docsCard, rowsRes.error);
        } else {
            const rows = rowsRes.rows;
            paintChart(aggregateByDay(rows, range), { truncated: rowsRes.total > rows.length, fetched: rows.length, total: rowsRes.total });
            paintRecent(rows);
            if (fin) {
                const ids = rows.filter((r) => r.status !== 'cancelled').slice(0, PAGE_SIZE).map((r) => r.id);
                if (!ids.length) paintGaps([]);
                else {
                    const docs = await call(app, 'registry_documents', { p_calcs: ids });
                    if (stale()) return;
                    if (docs.error) failCard(docsCard, docs.error);
                    else paintGaps(docGaps(rows, docs.data, LIST_ROWS));
                }
            }
        }
    }

    const root = h('section', { class: 'page kpd', 'aria-label': 'Дашборд' },
        h('div', { class: 'kpd-head' },
            h('h1', null, 'Дашборд'),
            periodBox, customBox, rangeNote,
            h('button', { type: 'button', class: 'kpd-link', onclick: openSite('overview') }, 'Детальний огляд →')),
        periodError,
        quick,
        kpis,
        grid);

    drawPeriods();
    if (typeof ResizeObserver === 'function') {
        let lastW = 0;
        observer = new ResizeObserver(() => {
            const w = Math.round(chartWrap.clientWidth || 0);
            if (w && Math.abs(w - lastW) >= 2) { lastW = w; drawChart(); }
        });
        observer.observe(root);
    }
    load();
    return root;
}
