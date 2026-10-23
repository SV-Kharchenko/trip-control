import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.equal(from >= 0, true, start);
    assert.equal(to > from, true, end);
    return source.slice(from, to);
}

const overviewCode = sliceBetween(html, "const OVERVIEW_PERIOD_KEY = 'tc_overview_period';", 'const TRIP_STATUSES = [');
const fleetCode = sliceBetween(html, 'const FLEET_DOCS = [', 'function fleetWriteError(');
const daysCode = sliceBetween(html, 'function ukDaysLabel(value)', 'function formatHistoryDays(');
const minusCode = sliceBetween(html, 'function displayMinus(text)', 'function numPlain(n)');

function makeDom() {
    const nodes = {};
    const node = function (id) {
        if (!nodes[id]) nodes[id] = { id: id, innerHTML: '', textContent: '', hidden: false };
        return nodes[id];
    };
    const store = {};
    return {
        nodes: nodes,
        store: store,
        document: {
            getElementById: node,
            querySelectorAll: function () { return []; },
            body: { getAttribute: function () { return 'overview'; } }
        },
        localStorage: {
            getItem: function (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
            setItem: function (key, value) { store[key] = String(value); }
        }
    };
}

function runOverview(state) {
    const dom = makeDom();
    const ctx = Object.assign({
        document: dom.document,
        localStorage: dom.localStorage,
        window: { scrollTo: function () {} },
        uiPreview: true,
        companyName: 'Агросвіт',
        savedCalculations: [],
        fleetVehicles: [],
        companySettings: {},
        currentWorkMode: 'solo',
        currentOrgRole: 'owner',
        currentUserId: 'u-owner',
        teamState: { members: [], seats: { used: 0, limit: 3 } },
        escHtml: function (t) { return String(t === undefined || t === null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
        numPlain: function (n) { return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.round(n)); },
        formatMoney: function (n) { return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(n) + ' грн'; },
        savedAuthorLabel: function (id) { return id === 'u-owner' ? 'Ви' : String(id); },
        setStudioView: function () {},
        openSaved: function () {},
        menuGo: function () {}
    }, state);
    ctx.teamEsc = ctx.escHtml;
    vm.runInNewContext(minusCode + daysCode + fleetCode + overviewCode + '\nrenderStudioOverview();\nglobalThis.__api = { setOverviewPeriod: setOverviewPeriod, ovShort: ovShort, overviewIsoWeek: overviewIsoWeek };', ctx);
    return { nodes: dom.nodes, store: dom.store, api: ctx.__api, ctx: ctx };
}

const row = function (id, createdAt, results, inputs, userId) {
    return Object.assign({ id: id, userId: userId || 'u-owner', routeName: 'Рейс ' + id, createdAt: createdAt, inputs: inputs || {} }, results);
};

test('the empty overview shows one hint instead of zero cards', () => {
    const out = runOverview({ savedCalculations: [] });
    assert.equal(out.nodes['overview-empty'].hidden, false);
    assert.equal(out.nodes['overview-body'].hidden, true);
    assert.equal((out.nodes['overview-kpis'] || { innerHTML: '' }).innerHTML, '');
    assert.equal(out.nodes['overview-weeks'], undefined);
    assert.equal(out.nodes['overview-kicker'].textContent, 'Агросвіт · кабінет директора');
});

test('the overview counts the chosen period against the previous one from saved results', () => {
    const rows = [
        row('a', '2026-10-05T09:00:00', { grossIncome: 6000000, ebitda: 1200000, netProfit: 700000, profitabilityPct: 11.6 }, { idleDays: 2, volume: '100' }),
        row('b', '2026-10-01T09:00:00', { grossIncome: 840000, ebitda: -80000, netProfit: -53456, profitabilityPct: -40.1 }, { volume: 60 }),
        row('c', '2026-09-12T09:00:00', { grossIncome: 5000000, ebitda: 900000, netProfit: 650000, profitabilityPct: 12 }, {})
    ];
    const fleetVehicles = [
        { id: 'v1', label: 'AA0001KA', make_model: 'Volvo FH', oscpv_on: '2026-10-09', kasko_on: null, green_card_on: null, inspection_on: null, tachograph_on: null, service_on: null },
        { id: 'v2', label: 'AA0002KA', make_model: 'DAF XF', oscpv_on: '2026-10-20', kasko_on: null, green_card_on: null, inspection_on: null, tachograph_on: null, service_on: null },
        { id: 'v3', label: 'AA0003KA', make_model: '', oscpv_on: '2027-05-01', kasko_on: null, green_card_on: null, inspection_on: null, tachograph_on: null, service_on: null }
    ];
    const out = runOverview({ savedCalculations: rows, fleetVehicles: fleetVehicles });
    const kpis = out.nodes['overview-kpis'].innerHTML;
    assert.equal(out.nodes['overview-empty'].hidden, true);
    assert.equal((kpis.match(/tc-ov-kpi/g) || []).length, 5);
    assert.match(kpis, />2<\/div><div class="d is-up">\+1 до мин\. місяця</);
    assert.match(kpis, /6,84 млн/);
    assert.match(kpis, /\+37%/);
    assert.match(kpis, /class="v is-up">647 тис</);
    assert.match(kpis, /−26,2 п\.п\./);

    const weeks = out.nodes['overview-weeks'].innerHTML;
    assert.equal((weeks.match(/class="tc-ov-bar /g) || []).length, 8);
    assert.match(weeks, /is-now[^]*тиж\. 42<\/span><\/div><\/div>$/);
    assert.match(weeks, /is-neg/);
    assert.equal(out.api.overviewIsoWeek(new Date(2026, 9, 12)), 42);

    const fleet = out.nodes['overview-fleet'].innerHTML;
    assert.equal(out.nodes['overview-fleet-count'].textContent, '3 авто');
    assert.match(fleet, /<b>1<\/b><span>документи в нормі/);
    assert.match(fleet, /<b>1<\/b><span>скоро спливають/);
    assert.match(fleet, /<b>1<\/b><span>прострочено/);
    assert.ok(fleet.indexOf('AA0001KA') < fleet.indexOf('AA0002KA'));
    assert.match(fleet, /ОСЦПВ · прострочено на 3 доби/);

    const idle = out.nodes['overview-idle'].innerHTML;
    assert.match(idle, /Рейс a<\/span><b class="soon">2 доби/);
    assert.match(idle, /Збиткові рейси<\/span><b class="is-down">1</);

    const logists = out.nodes['overview-authors'].innerHTML;
    assert.match(logists, /<td>Ви<\/td><td class="num">2<\/td>/);
    assert.equal(out.nodes['overview-team-seats'].hidden, true);

    const saved = out.nodes['overview-saved'].innerHTML;
    assert.equal((saved.match(/<tr onclick="openOverviewSaved/g) || []).length, 3);
    assert.ok(saved.indexOf("openOverviewSaved('b')") < saved.indexOf("openOverviewSaved('c')"));
    assert.match(saved, /tc-ov-badge is-down">−40,1%/);
    assert.equal(saved.includes('removeSaved'), false);
    assert.equal(out.nodes['overview-saved-count'].textContent, '3 шт');
});

test('period choice is remembered and the previous period without data shows a dash', () => {
    const rows = [row('a', '2026-10-12T09:00:00', { grossIncome: 900000, ebitda: 100000, netProfit: 50000, profitabilityPct: 5 })];
    const out = runOverview({ savedCalculations: rows });
    assert.equal(out.store.tc_overview_period, undefined);
    out.api.setOverviewPeriod('week');
    assert.equal(out.store.tc_overview_period, 'week');
    const kpis = out.nodes['overview-kpis'].innerHTML;
    assert.match(kpis, />1<\/div><div class="d">—</);
    assert.equal(out.api.ovShort(712400), '712 тис');
    assert.equal(out.api.ovShort(6840000), '6,84 млн');
    out.api.setOverviewPeriod('year');
    assert.equal(out.store.tc_overview_period, 'week');
});

test('the overview markup has the mockup layout without mockup numbers', () => {
    const section = sliceBetween(html, '<section id="studio-overview"', '</section>');
    assert.match(section, /Огляд компанії/);
    assert.match(section, /data-period="month" aria-pressed="true"/);
    ['Тиждень', 'Місяць', 'Квартал', 'Чистий прибуток по тижнях', 'Автопарк зараз', 'Можливий простій', 'Логісти', 'Збережені розрахунки'].forEach(function (text) {
        assert.ok(section.includes(text), text);
    });
    ['6,84', '712', '1,12', 'Олена Коваль', 'у рейсі', 'на ТО', '142'].forEach(function (text) {
        assert.equal(section.includes(text) || overviewCode.includes(text), false, text);
    });
    assert.equal(html.includes('Результати за авторами'), false);
    assert.match(sliceBetween(html, 'function renderKpiSparklines(opts)', 'function updateKpiSparklines('), /allowSample && real\.length < 3/);
    assert.equal((html.match(/renderKpiSparklines\(\{ sample: true \}\)/g) || []).length, 1);
    assert.match(sliceBetween(html, 'function showUiPreview()', 'renderKpiSparklines({ sample: true })'), /uiPreview = true;/);
    assert.match(html, /body\.view-logist #studio-nav-overview \{ display: none; \}/);
    assert.match(html, /if \(logistView && document\.body\.getAttribute\('data-studio-view'\) === 'overview'\) setStudioView\('calc'\);/);
});

test('negative overview numbers use the typographic minus sign', () => {
    const rows = [
        row('a', '2026-10-05T09:00:00', { grossIncome: 840000, ebitda: -80000, netProfit: -53456, profitabilityPct: -6.4 }, { volume: 60 })
    ];
    const out = runOverview({ savedCalculations: rows });
    const kpis = out.nodes['overview-kpis'].innerHTML;
    assert.match(kpis, /class="v is-down">−80 тис</);
    assert.match(kpis, /class="v is-down">−53 тис</);
    assert.match(kpis, /−6,4%/);
    assert.equal(/>-\d/.test(kpis), false);
    const saved = out.nodes['overview-saved'].innerHTML;
    assert.match(saved, /−53\s456/);
    assert.equal(/>-\d/.test(saved), false);
    assert.equal(out.api.ovShort(-712400), '−712 тис');
    assert.equal(out.api.ovShort(-500), '−500');
});

test('the result card shows the minus sign while money formatting stays plain', () => {
    const helper = sliceBetween(html, 'function displayMinus(text)', 'function numPlain(n)');
    const displayMinus = new Function(helper + '; return displayMinus;')();
    assert.equal(displayMinus('-6 687 грн'), '−6 687 грн');
    assert.equal(displayMinus('6 687 грн'), '6 687 грн');
    assert.equal(displayMinus('—'), '—');
    const paint = sliceBetween(html, 'function paintProfitHero(result)', 'function syncStudioSums(result)');
    assert.match(paint, /hero\.textContent = displayMinus\(formatMoney\(profit\)\)/);
    assert.match(paint, /perKm\.textContent = km > 0 \? displayMinus\(numPlain\(profit \/ km\)\)/);
    assert.equal(sliceBetween(html, 'function formatMoney(amount)', 'function contractFx()').includes('displayMinus'), false);
});
