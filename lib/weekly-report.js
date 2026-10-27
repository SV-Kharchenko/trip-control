// Weekly digest built from saved history. No calculator, no network.

const STATUS_LABEL = {
    draft: 'Чернетка',
    proposed: 'Запропоновано',
    pending: 'На погодженні',
    accepted: 'Прийнято',
    rejected: 'Відхилено',
    done: 'Виконано'
};

const LIST_LIMIT = 40;

export function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

export function validFrom(value) {
    const text = String(value || '').trim();
    if (!text || /[\r\n]/.test(text)) return false;
    const named = text.match(/^([^<>\r\n]{1,80})<([^<>]+)>$/);
    return validEmail(named ? named[2] : text);
}

export function reportRecipient(reportEmail, ownerEmail) {
    const report = String(reportEmail || '').trim();
    if (validEmail(report)) return report;
    const owner = String(ownerEmail || '').trim();
    if (validEmail(owner)) return owner;
    return '';
}

export function normalizeAlertPct(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 10;
}

export function factDeltaPct(actual, planned) {
    const a = Number(actual);
    const p = Number(planned);
    if (!Number.isFinite(a) || !Number.isFinite(p) || p === 0) return null;
    return (a - p) / Math.abs(p) * 100;
}

export function factIsAlert(actual, planned, threshold) {
    const a = Number(actual);
    const p = Number(planned);
    if (!Number.isFinite(a) || !Number.isFinite(p)) return false;
    const limit = normalizeAlertPct(threshold);
    if (p === 0) return a !== 0;
    return Math.abs((a - p) / Math.abs(p) * 100) > limit;
}

function kyivYmd(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type).value;
    return pick('year') + '-' + pick('month') + '-' + pick('day');
}

function shiftYmd(ymd, days) {
    const [year, month, day] = String(ymd).split('-').map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day));
    utc.setUTCDate(utc.getUTCDate() + days);
    const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(utc.getUTCDate()).padStart(2, '0');
    return utc.getUTCFullYear() + '-' + mm + '-' + dd;
}

function weekdayMonday1(ymd) {
    const [year, month, day] = String(ymd).split('-').map(Number);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return dow === 0 ? 7 : dow;
}

// Previous Monday–Sunday in Europe/Kyiv. Monday morning still reports the week that just ended.
export function previousWeekRange(now = new Date()) {
    const today = kyivYmd(now instanceof Date ? now : new Date(now));
    const thisMonday = shiftYmd(today, -(weekdayMonday1(today) - 1));
    const start = shiftYmd(thisMonday, -7);
    return { start, end: shiftYmd(start, 6) };
}

export function formatUah(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const text = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 }).format(Math.round(n));
    return text.replace(/[\u00a0\u202f]/g, ' ') + ' грн';
}

function formatDay(ymd) {
    const match = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return '—';
    return match[3] + '.' + match[2] + '.' + match[1];
}

function formatPct(value) {
    if (!Number.isFinite(value)) return '';
    const rounded = Math.round(value);
    const sign = rounded > 0 ? '+' : '';
    return sign + String(rounded).replace('-', '−') + '%';
}

function oneLine(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function ukNoun(n, one, few, many) {
    const abs = Math.abs(Number(n)) % 100;
    const last = abs % 10;
    if (abs >= 11 && abs <= 14) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
}

function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function routeLabel(trip) {
    const from = oneLine(trip.routeFrom);
    const to = oneLine(trip.routeTo);
    if (from && to) return from + ' → ' + to;
    return oneLine(trip.name) || 'Рейс';
}

function normalizeTrip(trip) {
    const actual = trip.actualProfit == null || trip.actualProfit === '' ? null : finite(trip.actualProfit);
    return {
        tripDate: String(trip.tripDate || '').slice(0, 10),
        route: routeLabel(trip),
        client: oneLine(trip.clientName),
        status: STATUS_LABEL[trip.status] ? trip.status : 'draft',
        revenue: finite(trip.revenue),
        profit: finite(trip.profit),
        actualProfit: actual
    };
}

function factNote(trip, threshold) {
    if (trip.actualProfit == null) return 'факт —';
    let note = 'факт ' + formatUah(trip.actualProfit);
    const pct = factDeltaPct(trip.actualProfit, trip.profit);
    if (pct != null) note += ' (' + formatPct(pct) + ')';
    else if (trip.profit === 0) note += ' (план 0)';
    if (factIsAlert(trip.actualProfit, trip.profit, threshold)) note += ', відхилення';
    return note;
}

function tripLine(trip, threshold) {
    const bits = [
        formatDay(trip.tripDate),
        trip.route,
        trip.client,
        STATUS_LABEL[trip.status] || 'Чернетка',
        'план ' + formatUah(trip.profit),
        factNote(trip, threshold)
    ].filter(Boolean);
    return bits.join(' · ');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderHtml(orgName, periodStart, periodEnd, summary, lines, threshold) {
    const items = lines.map((line) => '<li>' + escapeHtml(line) + '</li>').join('');
    const empty = summary.tripCount
        ? '<ul>' + items + '</ul>'
        : '<p>За цей тиждень збережених рейсів немає.</p>';
    return '<div style="font-family:sans-serif;font-size:14px;line-height:1.45;color:#14221f">' +
        '<p><b>TRIP-CONTROL · тижневий звіт</b><br>' +
        escapeHtml(oneLine(orgName) || 'Компанія') + '<br>' +
        escapeHtml(formatDay(periodStart) + '–' + formatDay(periodEnd)) +
        ' (понеділок–неділя, Київ)</p>' +
        '<p>Рейсів: ' + summary.tripCount + '<br>' +
        'План: дохід ' + escapeHtml(formatUah(summary.plannedRevenue)) +
        ', прибуток ' + escapeHtml(formatUah(summary.plannedProfit)) + '<br>' +
        'Факт внесено: ' + summary.factCount +
        '. Фактичний прибуток: ' + escapeHtml(summary.factCount ? formatUah(summary.actualProfit) : '—') + '<br>' +
        'Відхилення понад ' + threshold + '%: ' + summary.alertCount + '</p>' +
        empty +
        '<p>Звіт зібрано зі збереженої історії. Калькулятор рейси не перераховував.</p></div>';
}

export function buildWeeklyReport({ orgName, periodStart, periodEnd, trips, alertPct } = {}) {
    const threshold = normalizeAlertPct(alertPct);
    const rows = (Array.isArray(trips) ? trips : [])
        .map(normalizeTrip)
        .sort((a, b) => (a.tripDate + a.route).localeCompare(b.tripDate + b.route));
    const summary = {
        tripCount: rows.length,
        plannedRevenue: 0,
        plannedProfit: 0,
        factCount: 0,
        actualProfit: 0,
        alertCount: 0
    };
    rows.forEach((trip) => {
        if (trip.revenue != null) summary.plannedRevenue += trip.revenue;
        if (trip.profit != null) summary.plannedProfit += trip.profit;
        if (trip.actualProfit != null) {
            summary.factCount += 1;
            summary.actualProfit += trip.actualProfit;
            if (factIsAlert(trip.actualProfit, trip.profit, threshold)) summary.alertCount += 1;
        }
    });
    const listed = rows.slice(0, LIST_LIMIT);
    const lines = listed.map((trip) => tripLine(trip, threshold));
    const hidden = rows.length - listed.length;
    const header = [
        'TRIP-CONTROL · тижневий звіт',
        'Компанія: ' + (oneLine(orgName) || 'Компанія'),
        'Період: ' + formatDay(periodStart) + '–' + formatDay(periodEnd) + ' (понеділок–неділя, Київ)',
        '',
        'Рейсів: ' + summary.tripCount,
        'План: дохід ' + formatUah(summary.plannedRevenue) + ', прибуток ' + formatUah(summary.plannedProfit),
        'Факт внесено: ' + summary.factCount + '. Фактичний прибуток: ' +
            (summary.factCount ? formatUah(summary.actualProfit) : '—'),
        'Відхилення понад ' + threshold + '%: ' + summary.alertCount,
        '',
        'Рейси'
    ];
    if (!rows.length) header.push('За цей тиждень збережених рейсів немає.');
    const text = header.concat(lines).concat(hidden
        ? ['І ще ' + hidden + ' ' + ukNoun(hidden, 'рейс', 'рейси', 'рейсів') + '.']
        : []
    ).concat(['', 'Звіт зібрано зі збереженої історії. Калькулятор рейси не перераховував.']).join('\n');
    const subject = oneLine('TRIP-CONTROL: тиждень ' + formatDay(periodStart) + '–' + formatDay(periodEnd)).slice(0, 180);
    return {
        subject,
        text,
        html: renderHtml(orgName, periodStart, periodEnd, summary, lines.concat(hidden
            ? ['І ще ' + hidden + ' ' + ukNoun(hidden, 'рейс', 'рейси', 'рейсів') + '.']
            : []), threshold),
        summary,
        period: { start: periodStart, end: periodEnd },
        alertPct: threshold
    };
}

export function mailProvider(env) {
    const source = env || (typeof process !== 'undefined' ? process.env : {});
    const apiKey = String(source.RESEND_API_KEY || '').trim();
    const from = String(source.REPORT_FROM_EMAIL || '').trim();
    if (!apiKey || !validFrom(from)) return null;
    return { apiKey, from };
}

export function cronAuthorized(header, secret) {
    const expected = String(secret || '');
    const value = String(header || '');
    const got = value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
    if (!expected || got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) {
        diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
    }
    return diff === 0;
}

export async function deliverReport(message, options = {}) {
    const provider = mailProvider(options.env);
    if (!provider) {
        const error = new Error('Пошта для звітів не налаштована.');
        error.code = 'REPORT_MAIL_UNCONFIGURED';
        throw error;
    }
    const to = String(message && message.to || '').trim();
    if (!validEmail(to) || /[\r\n]/.test(to)) {
        const error = new Error('Немає адреси для звіту.');
        error.code = 'NO_RECIPIENT';
        throw error;
    }
    if (typeof options.fetch !== 'function') {
        const error = new Error('Пошта для звітів не налаштована.');
        error.code = 'REPORT_MAIL_UNCONFIGURED';
        throw error;
    }
    const response = await options.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + provider.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: provider.from,
            to: [to],
            subject: oneLine(message.subject).slice(0, 180),
            text: String(message.text || ''),
            html: String(message.html || '')
        })
    });
    if (!response.ok) {
        const error = new Error('Пошта не прийняла лист.');
        error.code = 'REPORT_MAIL_FAILED';
        error.status = response.status;
        throw error;
    }
    if (typeof response.json === 'function') return response.json().catch(() => ({}));
    return {};
}
