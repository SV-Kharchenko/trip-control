// Курс НБУ для документа (етап 4a): POST {currency: 'USD'|'EUR', date: 'YYYY-MM-DD'} → { currency, rate, rate_date }.
// Лише для користувача з дійсним JWT Supabase. До НБУ — сервер (браузер не ходить на bank.gov.ua: CSP застосунку без
// нових доменів). Таймаут 5 с, помилка НБУ — 502. Відповідь без кешу. У логи — лише код помилки, без JWT і тіл.
// Курс не «довірений»: kp_doc_create перевіряє його межі (rate > 0, дата курсу ≤ дати документа, не старша 7 днів).
export const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange';
export const RATE_CURRENCIES = ['USD', 'EUR'];
export const NBU_TIMEOUT_MS = 5000;

// Сьогодні за Києвом (YYYY-MM-DD).
export function kyivToday(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function validDate(text) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const [y, m, d] = text.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// null — параметри гаразд, інакше текст помилки 400.
export function rateParamsProblem(body, now = new Date()) {
    const currency = String((body && body.currency) || '').toUpperCase();
    const date = String((body && body.date) || '');
    if (!RATE_CURRENCIES.includes(currency)) return 'Курс НБУ — лише для USD або EUR.';
    if (!validDate(date)) return 'Дата — у форматі РРРР-ММ-ДД.';
    if (date < '2000-01-01') return 'Дата — не раніше 2000 року.';
    if (date > kyivToday(now)) return 'Дата курсу не може бути в майбутньому.';
    return null;
}

export function nbuUrl(currency, date) {
    return NBU_URL + '?valcode=' + encodeURIComponent(currency) + '&date=' + date.replace(/-/g, '') + '&json';
}

// '25.10.2026' → '2026-10-25'.
function isoFromNbu(text) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(text || ''));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parseBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body);
        } catch {
            return null;
        }
    }
    return {};
}

// getUser(jwt) → користувач або null; fetch — підмінний (тести); now — час (тести).
export function createRateHandler({ getUser, fetch = globalThis.fetch, now = () => new Date(), timeoutMs = NBU_TIMEOUT_MS, log = console }) {
    return async function rateHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
        }
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'Потрібно увійти.' });
        let user = null;
        try {
            user = await getUser(header.slice(7));
        } catch {
            user = null;
        }
        if (!user) return res.status(401).json({ code: 'BAD_TOKEN', error: 'Сесія завершилась — увійдіть ще раз.' });

        const body = parseBody(req);
        const problem = body === null ? 'Некоректне тіло запиту.' : rateParamsProblem(body, now());
        if (problem) return res.status(400).json({ code: 'BAD_PARAMS', error: problem });
        const currency = String(body.currency).toUpperCase();
        const date = String(body.date);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const upstream = await fetch(nbuUrl(currency, date), { signal: controller.signal, headers: { Accept: 'application/json' } });
            if (!upstream.ok) throw Object.assign(new Error('NBU_HTTP'), { status: upstream.status });
            const json = await upstream.json();
            const row = Array.isArray(json) ? json.find((r) => r && String(r.cc).toUpperCase() === currency) : null;
            const rate = row ? Number(row.rate) : NaN;
            if (!(rate > 0) || rate > 1000) throw new Error('NBU_BAD_DATA');
            return res.status(200).json({ currency, rate: Math.round(rate * 1e6) / 1e6, rate_date: isoFromNbu(row.exchangedate) || date, date });
        } catch (error) {
            const code = error && error.name === 'AbortError' ? 'NBU_TIMEOUT' : (error && error.message) || 'NBU_ERROR';
            log.warn('[docs/rate] ' + code + (error && error.status ? ' ' + error.status : ''));
            return res.status(502).json({ code: 'NBU_UNAVAILABLE', error: 'НБУ не відповів.' });
        } finally {
            clearTimeout(timer);
        }
    };
}
