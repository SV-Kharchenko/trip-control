// Сума прописом для рахунку й акта: 0 … 999 999 999,99 у гривнях, доларах або євро. Ціла частина — словами з правильним
// родом (одна гривня / один долар / одне євро, одна тисяча, два мільйони) і відмінком (гривня / гривні / гривень),
// дробова — двома цифрами зі словом у потрібній формі («01 копійка», «10 копійок»). Без float: рахуємо в копійках.

const UNITS = {
    m: ['', 'один', 'два', 'три', 'чотири', 'пʼять', 'шість', 'сім', 'вісім', 'девʼять'],
    f: ['', 'одна', 'дві', 'три', 'чотири', 'пʼять', 'шість', 'сім', 'вісім', 'девʼять'],
    n: ['', 'одне', 'два', 'три', 'чотири', 'пʼять', 'шість', 'сім', 'вісім', 'девʼять'],
};
const TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', 'пʼятнадцять', 'шістнадцять',
    'сімнадцять', 'вісімнадцять', 'девʼятнадцять'];
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', 'пʼятдесят', 'шістдесят', 'сімдесят', 'вісімдесят', 'девʼяносто'];
const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', 'пʼятсот', 'шістсот', 'сімсот', 'вісімсот', 'девʼятсот'];

// Рід і три форми: 1 (21, 101…), 2–4 (22–24…), 5–20 і 0 (11–14 теж).
const THOUSAND = { gender: 'f', forms: ['тисяча', 'тисячі', 'тисяч'] };
const MILLION = { gender: 'm', forms: ['мільйон', 'мільйони', 'мільйонів'] };

export const CURRENCY_WORDS = {
    UAH: { major: { gender: 'f', forms: ['гривня', 'гривні', 'гривень'] }, minor: { gender: 'f', forms: ['копійка', 'копійки', 'копійок'] } },
    USD: { major: { gender: 'm', forms: ['долар', 'долари', 'доларів'] }, minor: { gender: 'm', forms: ['цент', 'центи', 'центів'] } },
    EUR: { major: { gender: 'n', forms: ['євро', 'євро', 'євро'] }, minor: { gender: 'm', forms: ['цент', 'центи', 'центів'] } },
};

export const MAX_AMOUNT_CENTS = 99999999999;

export function pluralForm(n, forms) {
    const last = n % 10;
    const lastTwo = n % 100;
    if (last === 1 && lastTwo !== 11) return forms[0];
    if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return forms[1];
    return forms[2];
}

// 0…999 словами в потрібному роді ('' для 0).
function triad(n, gender) {
    const words = [];
    const h = Math.floor(n / 100);
    const rest = n % 100;
    if (h) words.push(HUNDREDS[h]);
    if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]);
    else {
        const t = Math.floor(rest / 10);
        const u = rest % 10;
        if (t) words.push(TENS[t]);
        if (u) words.push(UNITS[gender][u]);
    }
    return words.join(' ');
}

// Ціле 0…999 999 999 словами (рід — останнього розряду, тобто валюти).
export function integerWords(n, gender = 'm') {
    if (!Number.isInteger(n) || n < 0 || n > 999999999) throw new RangeError('integerWords: 0…999 999 999');
    if (n === 0) return 'нуль';
    const millions = Math.floor(n / 1000000);
    const thousands = Math.floor(n / 1000) % 1000;
    const rest = n % 1000;
    const parts = [];
    if (millions) parts.push(triad(millions, MILLION.gender), pluralForm(millions, MILLION.forms));
    if (thousands) parts.push(triad(thousands, THOUSAND.gender), pluralForm(thousands, THOUSAND.forms));
    if (rest) parts.push(triad(rest, gender));
    return parts.join(' ');
}

// Сума → копійки (ціле) без похибок float: '1234.5' / 1234.5 / '1 234,50' → 123450.
export function toCents(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new RangeError('toCents: not a number');
        value = value.toFixed(2);
    }
    const text = String(value == null ? '' : value).replace(/\s+/g, '').replace(',', '.');
    const match = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(text);
    if (!match) throw new RangeError('toCents: bad amount');
    const frac = (match[3] || '').padEnd(3, '0');
    let cents = Number(match[2]) * 100 + Number(frac.slice(0, 2));
    if (Number(frac[2]) >= 5) cents += 1;
    return match[1] ? -cents : cents;
}

export function amountInWords(value, currency = 'UAH') {
    const words = CURRENCY_WORDS[currency];
    if (!words) throw new RangeError('amountInWords: unknown currency ' + currency);
    const cents = toCents(value);
    if (cents < 0 || cents > MAX_AMOUNT_CENTS) throw new RangeError('amountInWords: 0…999 999 999,99');
    const major = Math.floor(cents / 100);
    const minor = cents % 100;
    const text = integerWords(major, words.major.gender) + ' ' + pluralForm(major, words.major.forms)
        + ' ' + String(minor).padStart(2, '0') + ' ' + pluralForm(minor, words.minor.forms);
    return text.charAt(0).toUpperCase() + text.slice(1);
}
