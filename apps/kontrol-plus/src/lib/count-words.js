// Маса й кількість місць прописом для ТТН (форма № 1-ТН: «кількість місць (словами)», «масою брутто, т (словами)»).
// Маса: тонни словами з родом і відмінком (одна тонна / дві тонни / пʼять тонн), кілограми — цифрами
// («двадцять чотири тонни 90 кг»). Без float: рахуємо в кілограмах. Сума прописом — amount-words.js (не змінюється).
import { integerWords, pluralForm } from './amount-words.js';

const TONNE = ['тонна', 'тонни', 'тонн'];
const PLACE = ['місце', 'місця', 'місць'];

// '24,09' / 24.09 / '24.090' → 24090 кг (округлення до кілограма половиною вгору).
export function toKg(value) {
    const text = typeof value === 'number'
        ? (Number.isFinite(value) ? value.toFixed(4) : '')
        : String(value == null ? '' : value).replace(/\s+/g, '').replace(',', '.');
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new RangeError('toKg: bad mass');
    const frac = (match[2] || '').padEnd(4, '0');
    let kg = Number(match[1]) * 1000 + Number(frac.slice(0, 3));
    if (Number(frac[3]) >= 5) kg += 1;
    return kg;
}

// 24.09 → «двадцять чотири тонни 90 кг»; 0,5 → «нуль тонн 500 кг»; 0 → «нуль тонн».
export function massInWords(value) {
    const kg = toKg(value);
    if (kg > 999999999999) throw new RangeError('massInWords: too large');
    const tonnes = Math.floor(kg / 1000);
    const rest = kg % 1000;
    const words = integerWords(tonnes, 'f') + ' ' + pluralForm(tonnes, TONNE);
    return rest ? words + ' ' + rest + ' кг' : words;
}

// 21 → «двадцять одне місце», 3 → «три місця», 0 → «нуль місць».
export function placesInWords(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 999999999) throw new RangeError('placesInWords: 0…999 999 999');
    return integerWords(n, 'n') + ' ' + pluralForm(n, PLACE);
}

// «39,84/15,75/24,09» — брутто / тара / нетто в операціях (порожнє — «—»).
export function massTriple(gross, tare, net) {
    const fmt = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '—'
        : new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 3, useGrouping: false }).format(Number(v)));
    return [gross, tare, net].map(fmt).join('/');
}
