// Документи (етап 4a): рахунки, акти, оплати, борги, реквізити компанії. Чисті функції для розділу «Документи» і PDF.
// Суми документа рахує сервер (kp_doc_create); previewTotals — лише попередній показ у формі тими самими правилами.
import { errorText } from './errors.js';
import { fmtDate, kyivDate } from './format.js';
import { digitsOnly, normalizeIban, edrpouChecksumOk, ipnChecksumOk, ibanChecksumOk, LEGAL_FORMS } from './validate.js';

export const DOC_KIND_LABELS = { invoice: 'Рахунок', act: 'Акт', ttn: 'ТТН' };
export const DOC_TITLES = { invoice: 'Рахунок на оплату', act: 'Акт надання послуг' };
export const PAY_STATUS_LABELS = {
    issued: 'Виставлено',
    partial: 'Частково оплачено',
    paid: 'Оплачено',
    overdue: 'Прострочено',
    cancelled: 'Анульовано',
};
// Акти не мають оплат: «Створено» -> «Підписано» (підписав директор), «Анульовано» лишається. Рахунки — статуси оплати вище.
export const ACT_STATUS_LABELS = { created: 'Створено', signed: 'Підписано', cancelled: 'Анульовано' };

// Ключ статусу для відображення: для акта — created | signed | cancelled, для решти — pay_status як є.
export function docStatusKey(kind, payStatus, signed = false) {
    if (kind !== 'act') return payStatus;
    if (payStatus === 'cancelled') return 'cancelled';
    return signed ? 'signed' : 'created';
}

export function docStatusLabel(kind, payStatus, signed = false) {
    const key = docStatusKey(kind, payStatus, signed);
    return (kind === 'act' ? ACT_STATUS_LABELS : PAY_STATUS_LABELS)[key] || key;
}

export const CURRENCIES = ['UAH', 'USD', 'EUR'];
export const CURRENCY_SHORT = { UAH: 'грн', USD: 'USD', EUR: 'EUR' };
export const VAT_MODES = [
    { value: 'net', label: 'Ціна без ПДВ (+20 % зверху)' },
    { value: 'gross', label: 'Ціна вже з ПДВ (виділяємо ПДВ всередині)' },
];
export const MAX_LINES = 200;
export const ASSET_MAX_BYTES = 524288;
export const ASSET_BUCKET = 'kp-doc-assets';
export const DEFAULT_TERMS_DAYS = 5;

// Права в інтерфейсі (база однаково перевіряє): читають owner / logist / director; пишуть owner / logist;
// анулювання, реквізити, підпис і печатка — лише owner.
export function docsAccess(context) {
    const role = context && context.control_plus === true ? context.role : null;
    return {
        visible: role === 'owner' || role === 'logist' || role === 'director',
        canWrite: role === 'owner' || role === 'logist',
        isOwner: role === 'owner',
    };
}

const money2 = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateFmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

// «1 234,56 грн» / «1 234,56 USD».
export function fmtAmount(value, currency = 'UAH') {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '—';
    return money2.format(n) + ' ' + (CURRENCY_SHORT[currency] || currency);
}

export function fmtMoneyPlain(value) {
    const n = Number(value);
    return Number.isFinite(n) ? money2.format(n) : '—';
}

export function fmtRate(value) {
    const n = Number(value);
    return Number.isFinite(n) ? rateFmt.format(n) : '—';
}

export function fmtQty(value) {
    const n = Number(value);
    return Number.isFinite(n) ? new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3 }).format(n) : '—';
}

export function docNumberText(doc) {
    if (!doc) return '';
    return doc.number_text || (doc.prefix || '') + String(doc.number ?? '');
}

const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

// «12 жовтня 2026 р.»
export function dateWords(iso) {
    const [y, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return String(iso || '');
    return `${d} ${MONTHS_GEN[m - 1]} ${y} р.`;
}

// Копійки, як на сервері: рядок = round(qty × price, 2) з округленням половини вгору.
function cents(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100 + Math.sign(n) * 1e-7) : NaN;
}

export function lineAmount(qty, price) {
    const q = Number(qty);
    const p = cents(price);
    if (!Number.isFinite(q) || !Number.isFinite(p)) return NaN;
    return Math.round(q * p + 1e-7) / 100;
}

// Попередній показ сум (сервер рахує сам): net — ПДВ = round(Σ × 0,2), total = Σ + ПДВ; gross — total = Σ,
// ПДВ = round(Σ × 20 / 120), subtotal = total − ПДВ; неплатник — без ПДВ.
export function previewTotals(lines, { vatPayer, vatMode }) {
    const sum = (lines || []).reduce((s, l) => s + Math.round(lineAmount(l.qty, l.price) * 100), 0);
    if (!Number.isFinite(sum)) return { subtotal: NaN, vat: NaN, total: NaN, vatRate: vatPayer ? 20 : 0 };
    let subtotal = sum;
    let vat = 0;
    let total = sum;
    if (vatPayer && vatMode === 'gross') {
        vat = Math.round((sum * 20) / 120);
        subtotal = sum - vat;
    } else if (vatPayer) {
        vat = Math.round(sum * 0.2);
        total = sum + vat;
    }
    return { subtotal: subtotal / 100, vat: vat / 100, total: total / 100, vatRate: vatPayer ? 20 : 0 };
}

export function tripRoute(trip) {
    const route = [trip.route_from, trip.route_to].filter(Boolean).join(' — ');
    return route || trip.name || 'рейс';
}

export function defaultLineTitle(trip) {
    return 'Послуги з перевезення вантажу за маршрутом ' + tripRoute(trip) + (trip.trip_date ? ', ' + fmtDate(trip.trip_date) : '');
}

export function tripsToLines(trips) {
    return (trips || []).map((t) => ({
        title: defaultLineTitle(t),
        unit: 'послуга',
        qty: 1,
        price: Number(t.price) || 0,
        calculation_id: t.calculation_id,
    }));
}

// Перевірка рядків до відправлення (ті самі межі, що в kp_doc_create). Повертає { index: текст }.
export function validateLines(lines) {
    const errors = {};
    if (!lines || !lines.length) errors.all = 'Додайте хоча б один рядок';
    else if (lines.length > MAX_LINES) errors.all = 'Не більше ' + MAX_LINES + ' рядків у документі';
    (lines || []).forEach((l, i) => {
        const title = String(l.title || '').trim();
        const qty = Number(String(l.qty).replace(',', '.'));
        const price = Number(String(l.price).replace(',', '.'));
        if (!title) errors[i] = 'Вкажіть найменування';
        else if (title.length > 500) errors[i] = 'Найменування довше за 500 символів';
        else if (!(qty > 0) || qty > 1000000) errors[i] = 'Кількість має бути більшою за 0';
        else if (!(price >= 0) || price > 1000000000 || String(l.price).trim() === '') errors[i] = 'Ціна не може бути відʼємною';
        else if (String(l.unit || '').trim().length > 20) errors[i] = 'Одиниця — до 20 символів';
    });
    return errors;
}

// Рядки для kp_doc_create.
export function linesPayload(lines) {
    return lines.map((l) => {
        const out = {
            title: String(l.title || '').trim(),
            unit: String(l.unit || '').trim() || 'послуга',
            qty: Number(String(l.qty).replace(',', '.')),
            price: Number(String(l.price).replace(',', '.')),
        };
        if (l.calculation_id) out.calculation_id = l.calculation_id;
        return out;
    });
}

export function dueDateFor(docDate, termsDays) {
    const days = termsDays === null || termsDays === undefined || termsDays === '' ? DEFAULT_TERMS_DAYS : Number(termsDays);
    const t = Date.parse(String(docDate) + 'T00:00:00Z');
    if (!Number.isFinite(t) || !Number.isFinite(days)) return '';
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

// Курс: дата курсу ≤ дати документа і не старша за 7 днів (як перевіряє сервер).
export function rateProblem(currency, rate, rateDate, docDate) {
    if (currency === 'UAH') return null;
    const r = Number(String(rate || '').replace(',', '.'));
    if (!(r > 0)) return 'Вкажіть курс НБУ (більше 0)';
    if (!rateDate) return 'Вкажіть дату курсу';
    if (rateDate > docDate) return 'Дата курсу не може бути пізнішою за дату документа';
    const days = Math.round((Date.parse(docDate + 'T00:00:00Z') - Date.parse(rateDate + 'T00:00:00Z')) / 86400000);
    if (days > 7) return 'Курс старший за 7 днів — оновіть курс';
    return null;
}

export function docFileName(doc) {
    const kind = doc.kind === 'act' ? 'akt' : doc.kind === 'invoice' ? 'rakhunok' : String(doc.kind || 'doc');
    return `${kind}_${doc.number}_${String(doc.doc_date || kyivDate()).slice(0, 10)}${doc.status === 'cancelled' ? '_anulovano' : ''}.pdf`;
}

// Реквізити компанії: формат як у клієнтів (ті самі CHECK-и в базі), контрольні суми — попередження.
const PREFIX = /^[0-9A-Za-zА-яҐґЄєІіЇї/._-]{1,10}$/;
function clean(value) {
    const text = String(value == null ? '' : value).trim();
    return text === '' ? null : text;
}

export function validateRequisites(input) {
    const errors = {};
    const warnings = {};
    const data = {
        legal_name: clean(input.legal_name),
        legal_form: clean(input.legal_form),
        edrpou: clean(digitsOnly(input.edrpou)),
        ipn: clean(digitsOnly(input.ipn)),
        vat_payer: Boolean(input.vat_payer),
        vat_number: clean(digitsOnly(input.vat_number)),
        iban: clean(normalizeIban(input.iban)),
        bank_name: clean(input.bank_name),
        legal_address: clean(input.legal_address),
        signer_name: clean(input.signer_name),
        signer_position: clean(input.signer_position),
        doc_place: clean(input.doc_place),
        invoice_prefix: clean(input.invoice_prefix),
        act_prefix: clean(input.act_prefix),
        ttn_prefix: clean(input.ttn_prefix),
        default_currency: clean(input.default_currency) || 'UAH',
        default_vat_mode: clean(input.default_vat_mode) || 'net',
    };
    if (!data.legal_name) errors.legal_name = 'Вкажіть повну назву компанії';
    else if (data.legal_name.length > 300) errors.legal_name = 'Назва довша за 300 символів';
    if (data.legal_form && !LEGAL_FORMS.some((f) => f.value === data.legal_form)) errors.legal_form = 'Невідома форма';
    if (data.edrpou) {
        if (data.edrpou.length !== 8) errors.edrpou = 'ЄДРПОУ — 8 цифр';
        else if (!edrpouChecksumOk(data.edrpou)) warnings.edrpou = 'Контрольна цифра ЄДРПОУ не збігається — перевірте код';
    }
    if (data.ipn) {
        if (data.ipn.length !== 10) errors.ipn = 'ІПН (РНОКПП) — 10 цифр';
        else if (!ipnChecksumOk(data.ipn)) warnings.ipn = 'Контрольна цифра ІПН не збігається — перевірте номер';
    }
    if (!data.edrpou && !data.ipn && !errors.edrpou && !errors.ipn) errors.edrpou = 'Для документів потрібен ЄДРПОУ або ІПН';
    if (data.vat_number && data.vat_number.length !== 10 && data.vat_number.length !== 12) errors.vat_number = 'Номер платника ПДВ — 10 або 12 цифр';
    if (data.vat_payer && !data.vat_number) warnings.vat_number = 'Платник ПДВ без ІПН платника ПДВ';
    if (data.iban) {
        if (!/^UA[0-9]{27}$/.test(data.iban)) errors.iban = 'IBAN України: UA і 27 цифр';
        else if (!ibanChecksumOk(data.iban)) warnings.iban = 'Контрольна сума IBAN не збігається — перевірте рахунок';
    } else warnings.iban = 'Без IBAN рахунок на оплату не створити';
    for (const [key, max] of [['bank_name', 300], ['legal_address', 500], ['signer_name', 200], ['signer_position', 200], ['doc_place', 200]]) {
        if (data[key] && data[key].length > max) errors[key] = 'Не довше ' + max + ' символів';
    }
    for (const key of ['invoice_prefix', 'act_prefix', 'ttn_prefix']) {
        if (data[key] && !PREFIX.test(data[key])) errors[key] = 'До 10 символів: літери, цифри, / . _ -';
    }
    if (!CURRENCIES.includes(data.default_currency)) errors.default_currency = 'Невідома валюта';
    if (!VAT_MODES.some((m) => m.value === data.default_vat_mode)) errors.default_vat_mode = 'Невідомий режим ПДВ';
    return { data, errors, warnings };
}

// Файл підпису / печатки: PNG або JPEG до 512 КБ (Storage і бакет перевіряють те саме). Тип — за першими байтами.
export function sniffImage(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    return null;
}

export function assetProblem({ type, size, bytes }) {
    if (!['image/png', 'image/jpeg'].includes(type)) return 'Лише PNG або JPEG';
    if (!(size > 0)) return 'Порожній файл';
    if (size > ASSET_MAX_BYTES) return 'Файл більший за 512 КБ';
    const kind = bytes ? sniffImage(bytes) : null;
    if (bytes && !kind) return 'Файл не схожий на PNG чи JPEG';
    if (kind && (kind === 'png') !== (type === 'image/png')) return 'Розширення не відповідає вмісту файлу';
    return null;
}

export function assetPath(orgId, kind, ext) {
    return `${orgId}/${kind}.${ext === 'jpg' ? 'jpg' : 'png'}`;
}

// Борги: підсумки окремо за валютами (суми різних валют не додаються).
export function debtTotals(rows) {
    const out = {};
    for (const r of rows || []) {
        const t = out[r.currency] || (out[r.currency] = { invoiced: 0, paid: 0, debt: 0, overdue: 0 });
        for (const key of ['invoiced', 'paid', 'debt', 'overdue']) t[key] = Math.round((t[key] + Number(r[key] || 0)) * 100) / 100;
    }
    return out;
}

export function sortDebts(rows, key = 'overdue') {
    const list = [...(rows || [])];
    const num = (v) => Number(v || 0);
    if (key === 'debt') list.sort((a, b) => num(b.debt) - num(a.debt) || num(b.overdue) - num(a.overdue) || String(a.client_name).localeCompare(String(b.client_name), 'uk'));
    else if (key === 'days') list.sort((a, b) => num(b.overdue_days) - num(a.overdue_days) || num(b.overdue) - num(a.overdue));
    else if (key === 'name') list.sort((a, b) => String(a.client_name).localeCompare(String(b.client_name), 'uk'));
    else list.sort((a, b) => num(b.overdue) - num(a.overdue) || num(b.debt) - num(a.debt) || String(a.client_name).localeCompare(String(b.client_name), 'uk'));
    return list;
}

const DOC_ERRORS = [
    [/KP_FORBIDDEN/, 'Недостатньо прав для цієї дії.'],
    [/REQUISITES_REQUIRED/, 'Спершу заповніть реквізити компанії: назва, ЄДРПОУ або ІПН, для рахунку — IBAN.'],
    [/REQUISITES_ASSET_MISSING/, 'Файл підпису чи печатки не завантажено. Спробуйте ще раз.'],
    [/REQUISITES_BAD/, 'Перевірте реквізити компанії.'],
    [/DOC_NUMBER_TAKEN/, 'Документ з таким номером цього року вже є (номери анульованих теж зайняті).'],
    [/DOC_BAD_NUMBER/, 'Номер — ціле число від 1.'],
    [/DOC_BAD_LINES/, 'Перевірте рядки: найменування, кількість більша за 0, ціна не відʼємна, 1–200 рядків.'],
    [/DOC_ZERO_TOTAL/, 'Сума документа має бути більшою за 0.'],
    [/DOC_TOTAL_TOO_LARGE/, 'Сума документа завелика (до 999 999 999,99).'],
    [/DOC_TRIP_FORBIDDEN/, 'Рейс не належить цьому клієнту або недоступний вам.'],
    [/TRIP_ALREADY_BILLED/, 'Цей рейс уже є в активному документі такого типу. Анулюйте той документ або приберіть рейс.'],
    [/DOC_BAD_RATE/, 'Перевірте курс: більше 0, дата курсу не пізніше дати документа і не старша за 7 днів.'],
    [/DOC_BAD_CURRENCY/, 'Невідома валюта.'],
    [/DOC_BAD_VAT_MODE/, 'Невідомий режим ПДВ.'],
    [/DOC_BAD_PARENT/, 'Акт можна привʼязати лише до активного рахунку того самого клієнта.'],
    [/DOC_BAD_DUE_DATE/, 'Строк оплати — не раніше дати документа і не пізніше ніж через рік.'],
    [/DOC_BAD_KIND|DOC_KIND_NOT_READY/, 'Цей тип документа ще недоступний.'],
    [/DOC_NOT_FOUND/, 'Документ не знайдено.'],
    [/DOC_ALREADY_CANCELLED/, 'Документ уже анульовано.'],
    [/DOC_SIGN_ACT_ONLY/, 'Підписувати можна лише акти.'],
    [/DOC_CANCEL_REASON/, 'Вкажіть причину анулювання (до 500 символів).'],
    [/DOC_HAS_PAYMENTS/, 'Спершу анулюйте оплати цього рахунку.'],
    [/DOC_CANCELLED/, 'Анульований документ не приймає оплат.'],
    [/DOC_BAD_STATUS/, 'Невідомий статус.'],
    [/PAYMENT_EXCEEDS/, 'Оплата більша за залишок боргу.'],
    [/PAYMENT_NOT_INVOICE/, 'Оплати відмічаються лише на рахунках.'],
    [/PAYMENT_BAD_DATE/, 'Дата оплати — не в майбутньому.'],
    [/PAYMENT_BAD_AMOUNT/, 'Сума оплати має бути більшою за 0.'],
    [/PAYMENT_BAD_NOTE/, 'Коментар до оплати — до 500 символів.'],
    [/PAYMENT_NOT_FOUND/, 'Оплату не знайдено.'],
    [/PAYMENT_ALREADY_VOIDED/, 'Оплату вже анульовано.'],
    [/CLIENT_ARCHIVED/, 'Клієнт в архіві — поверніть його з архіву, щоб виставити документ.'],
    [/BAD_DATE/, 'Перевірте дату.'],
    [/kp_documents_client_id_fkey/, 'Клієнта з документами не можна видалити — перенесіть його в архів.'],
    [/DOC_ASSETS_NOT_COPIED|DOC_ID_TAKEN/, 'Не вдалося додати підпис і печатку до документа. Спробуйте ще раз.'],
];

// Підпис / печатка в PDF — лише знімок цього документа (<org>/docs/<id>/…), ніколи не поточний файл реквізитів:
// заміна чи видалення підпису в реквізитах виданого документа не змінює. Інший шлях — PDF без картинки.
export function docAssetPaths(doc) {
    const seller = (doc && doc.seller) || {};
    const own = (kind) => {
        const path = seller[kind + '_path'];
        const m = /^[0-9a-f-]{36}\/docs\/([0-9a-f-]{36})\/(signature|stamp)\.(png|jpg)$/.exec(String(path || ''));
        return m && doc.id && m[1] === doc.id && m[2] === kind ? path : null;
    };
    return { signature: own('signature'), stamp: own('stamp') };
}

// Створення документа: сервер копіює поточні підпис і печатку реквізитів у знімок документа (/api/docs/assets → id),
// потім kp_doc_create з тим самим id. Реквізити змінили між кроками (DOC_ASSETS_NOT_COPIED) — ще одна спроба.
// → { id } або { errorText }.
export async function createDocument(app, params, callApi) {
    let error = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const prep = await callApi(app, '/api/docs/assets', {});
        if (!prep.ok) return { errorText: prep.code === 'KP_FORBIDDEN' ? docErrorText('KP_FORBIDDEN') : prep.error };
        const res = await app.supabase.rpc('kp_doc_create', { ...params, p_id: prep.doc_id });
        if (!res.error) return { id: res.data };
        error = res.error;
        if (!/DOC_ASSETS_NOT_COPIED/.test(String(error.message || ''))) break;
    }
    return { errorText: docErrorText(error) };
}

export function docErrorText(error) {
    const message = String((error && (error.message || error.error_description)) || error || '');
    for (const [pattern, text] of DOC_ERRORS) if (pattern.test(message)) return text;
    return errorText(error);
}

// Функцій розділу ще немає в базі (міграцію 4a не застосовано) — PostgREST: PGRST202 / 42883.
export function isMissingFeature(error) {
    if (!error) return false;
    return error.code === 'PGRST202' || error.code === '42883' || /Could not find the function|does not exist/i.test(String(error.message || ''));
}
