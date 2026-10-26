// Тексти ТТН за формою № 1-ТН (додаток 7 до Правил перевезень вантажів автомобільним транспортом в Україні, редакція
// наказу Мінрозвитку № 1727 від 12.12.2025) — спільні для PDF, Excel і картки. Порядок і назви реквізитів — як у формі;
// порожній реквізит друкується прочерком (поля не прибираємо). Без pdf-lib.
import { amountInWords } from './amount-words.js';
import { massInWords, massTriple, placesInWords } from './count-words.js';
import { fmtDate } from './format.js';
import { dateWords, fmtMoneyPlain, docNumberText } from './docs.js';

export const DASH = '—';
export const APPENDIX_REF = 'Додаток 7 до Правил перевезень вантажів автомобільним транспортом в Україні (пункт 11.1 глави 11)';
export const FORM_NO = 'Форма № 1-ТН';
export const TTN_TITLE = 'ТОВАРНО-ТРАНСПОРТНА НАКЛАДНА';

// Офіційні виноски форми (*, **, ***) і дві додаткові (****, *****) — для позначок у рядках вантажу.
export const FOOTNOTES = [
    '* відомості заповнюються у випадках, передбачених Положенням про робочий час і час відпочинку водіїв колісних транспортних засобів, затвердженим наказом Міністерства транспорту та зв’язку України від 07 червня 2010 року № 340.',
    '** відомості заповнюються у разі перевезення туш, напівтуш, четвертин, відрубів, шматків м’яса.',
    '*** відомості заповнюються у разі перевезення харчових продуктів, які потребують дотримання температурного режиму.',
    '**** ОЦВТ — облікова ціна власника товару (ціну не зазначено перевізнику).',
    '***** для вантажу насипом / наливом маса брутто дорівнює масі нетто.',
];

// Графи «Відомості про вантаж» (№ з/п і графи 1–11).
export const CARGO_COLUMNS = [
    { key: 'n', title: '№ з/п', no: '' },
    { key: 'cargo_name', title: 'Найменування вантажу (туші, напівтуші, четвертини, відруби, шматки м’яса)** / номер контейнера; клас небезпечних речовин', no: '1' },
    { key: 'animal_id', title: 'Ідентифікаційний номер тварини, від якої отримано сировину**', no: '2' },
    { key: 'animal_kind', title: 'Вид тварини**', no: '3' },
    { key: 'temperature', title: 'Температурний режим транспортування***', no: '4' },
    { key: 'unit', title: 'Одиниця вимірювання', no: '5' },
    { key: 'places', title: 'Кількість місць', no: '6' },
    { key: 'price', title: 'Ціна без ПДВ за одиницю, грн', no: '7' },
    { key: 'amount', title: 'Загальна сума з ПДВ, грн', no: '8' },
    { key: 'packaging', title: 'Вид пакування', no: '9' },
    { key: 'docs', title: 'Документи з вантажем', no: '10' },
    { key: 'gross_t', title: 'Маса брутто, т', no: '11' },
];

export const OPERATION_LABELS = { load: 'Завантаження', unload: 'Розвантаження' };

const massFmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 3, useGrouping: false });
const dimFmt = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

export function fmtMass(value) {
    const n = Number(value);
    return value === null || value === undefined || value === '' || !Number.isFinite(n) ? DASH : massFmt.format(n);
}

export function fmtDim(value) {
    const n = Number(value);
    return value === null || value === undefined || value === '' || !Number.isFinite(n) ? DASH : dimFmt.format(n);
}

function orDash(value) {
    const text = String(value == null ? '' : value).trim();
    return text || DASH;
}

// Код сторони з назвою виду: 8 цифр — ЄДРПОУ, 10 — РНОКПП, 9 — ID-картка, 2 літери + 6 цифр — паспорт.
export function codeText(code) {
    const c = String(code || '');
    if (/^[0-9]{8}$/.test(c)) return 'код ЄДРПОУ ' + c;
    if (/^[0-9]{10}$/.test(c)) return 'РНОКПП ' + c;
    if (/^[0-9]{9}$/.test(c)) return 'паспорт (ID-картка) № ' + c;
    if (c) return 'паспорт ' + c;
    return '';
}

export function partyText(p) {
    if (!p || (!p.name && !p.code)) return DASH;
    return [p.name, codeText(p.code), p.address].filter(Boolean).join(', ');
}

export function vehicleText(v) {
    const x = v || {};
    const parts = [x.make_model, x.type, x.reg_number].filter(Boolean);
    return parts.length ? parts.join(', ') : DASH;
}

export function trailerText(v) {
    const x = v || {};
    const parts = [x.trailer_make_model, x.trailer_type, x.trailer_reg_number].filter(Boolean);
    return parts.length ? parts.join(', ') : DASH;
}

export function driverText(d) {
    const x = d || {};
    if (!x.full_name && !x.license_no) return DASH;
    return [x.full_name, x.license_no ? 'посвідчення водія ' + x.license_no : null].filter(Boolean).join(', ');
}

export function placesWords(doc) {
    return doc.places_count === null || doc.places_count === undefined ? DASH : placesInWords(Number(doc.places_count));
}

export function grossWords(doc) {
    return doc.cargo_gross_t === null || doc.cargo_gross_t === undefined ? DASH : massInWords(doc.cargo_gross_t);
}

// «Усього відпущено на загальну суму … (словами, з урахуванням ПДВ), у тому числі ПДВ …». Без суми — «ОЦВТ****»,
// якщо вантаж за обліковою ціною власника, інакше прочерк.
export function amountWords(doc) {
    if (doc.total_amount === null || doc.total_amount === undefined) {
        return (doc.lines || []).some((l) => l.owner_price) ? 'ОЦВТ****' : DASH;
    }
    return amountInWords(doc.total_amount, 'UAH');
}

export function vatText(doc) {
    if (doc.total_amount === null || doc.total_amount === undefined) return DASH;
    return doc.vat_amount === null || doc.vat_amount === undefined ? 'без ПДВ' : fmtMoneyPlain(doc.vat_amount) + ' грн';
}

// «Відомості про ТЗ»: довжина, ширина, висота, загальна маса з вантажем і маса брутто.
export function vehicleParams(doc) {
    const v = doc.vehicle || {};
    return {
        length: fmtDim(v.length_m),
        width: fmtDim(v.width_m),
        height: fmtDim(v.height_m),
        mass: `${fmtMass(doc.total_mass_t)} т з вантажем (тара ${fmtMass(doc.tare_t)} т), маса брутто вантажу ${fmtMass(doc.cargo_gross_t)} т`,
    };
}

export function ttnHeading(doc) {
    return `${TTN_TITLE} № ${docNumberText(doc)} від ${dateWords(doc.doc_date)}`;
}

// Реквізити лицьового боку в порядку форми: [підпис, значення, пояснення під рядком].
export function frontFields(doc) {
    const params = vehicleParams(doc);
    const rows = [
        ['Місце складання', orDash(doc.place_of_issue), null],
        ['Автомобіль', vehicleText(doc.vehicle), '(марка, модель, тип, реєстраційний номер)'],
        ['Причіп / напівпричіп', trailerText(doc.vehicle), '(марка, модель, тип, реєстраційний номер)'],
        ['Вид перевезень', orDash(doc.transport_kind), null],
        ['Місце, де зберігається автомобіль*', orDash(doc.vehicle_parking_place), '(адреса місцезнаходження автомобільного перевізника, його структурного підрозділу або філії)'],
        ['Автомобільний перевізник', partyText(doc.carrier), '(повне найменування / ПІБ, код платника податків)'],
        ['Водій', driverText(doc.driver), '(ПІБ, номер посвідчення водія)'],
        ['Вантажовідправник', partyText(doc.shipper), '(повне найменування / ПІБ, код платника податків)'],
        ['Вантажоодержувач', partyText(doc.consignee), '(повне найменування / ПІБ, код платника податків)'],
        ['Пункт навантаження', orDash(doc.load_point), '(місцезнаходження)'],
        ['Пункт розвантаження', orDash(doc.unload_point), '(місцезнаходження)'],
        ['Кількість місць', placesWords(doc), '(словами)'],
        ['Масою брутто, т', grossWords(doc), '(словами)'],
        ['Отримав водій / експедитор', orDash(doc.received_by), '(ПІБ, посада, підпис)'],
        ['Відомості про транспортний засіб', `довжина ${params.length} м; ширина ${params.width} м; висота ${params.height} м; ${params.mass}`,
            '(автомобіль / автопоїзд; довжина, ширина, висота, м; загальна маса з вантажем та маса брутто, т)'],
        ['Усього відпущено на загальну суму', amountWords(doc) + ', у тому числі ПДВ ' + vatText(doc), '(словами, з урахуванням ПДВ)'],
        ['Супровідні документи на вантаж', orDash(doc.accompanying_docs), null],
    ];
    // Додаткові реквізити (п. 11.1 Правил: форму можна доповнити) — лише якщо вказані.
    const extra = [
        ['Замовник (платник)', doc.customer ? partyText(doc.customer) : null],
        ['Експедитор', doc.forwarder ? partyText(doc.forwarder) : null],
        ['Переадресування вантажу', doc.readdressing || null],
        ['Вантаж відповідає правилам перевезення; номер пломби', doc.seal_note || null],
    ].filter(([, value]) => value).map(([label, value]) => [label, value, '(додатковий реквізит, п. 11.1 Правил)']);
    return rows.concat(extra);
}

// Комірки рядка вантажу (текстом; числа — у форматі uk-UA).
export function cargoCells(line, index) {
    return {
        n: String(index + 1),
        cargo_name: line.cargo_name || DASH,
        animal_id: line.animal_id || DASH,
        animal_kind: line.animal_kind || DASH,
        temperature: line.temperature || DASH,
        unit: line.unit || DASH,
        places: line.places === null || line.places === undefined ? DASH : String(line.places),
        price: line.owner_price ? 'ОЦВТ****' : line.price === null || line.price === undefined ? DASH : fmtMoneyPlain(line.price),
        amount: line.amount === null || line.amount === undefined ? (line.owner_price ? 'ОЦВТ****' : DASH) : fmtMoneyPlain(line.amount),
        packaging: line.packaging ? line.packaging + (line.bulk ? '*****' : '') : (line.bulk ? 'Насипом / наливом*****' : DASH),
        docs: line.docs || DASH,
        gross_t: fmtMass(line.gross_t),
    };
}

export function cargoTotals(doc) {
    const lines = doc.lines || [];
    const places = lines.some((l) => l.places !== null && l.places !== undefined) ? lines.reduce((s, l) => s + Number(l.places || 0), 0) : null;
    const amount = lines.some((l) => l.amount !== null && l.amount !== undefined) ? lines.reduce((s, l) => s + Math.round(Number(l.amount || 0) * 100), 0) / 100 : null;
    return {
        places: places === null ? DASH : String(places),
        amount: amount === null ? DASH : fmtMoneyPlain(amount),
        gross_t: fmtMass(doc.cargo_gross_t),
    };
}

// Рядки «Вантажно-розвантажувальні операції»: маса брутто / тара / нетто («39,84/15,75/24,09»), час прибуття, вибуття, простою.
export function operationRows(doc) {
    const ops = Array.isArray(doc.operations) ? doc.operations : [];
    return ['load', 'unload'].map((op) => {
        const o = ops.find((x) => x && x.op === op) || {};
        const hasMass = [o.gross_t, o.tare_t, o.net_t].some((v) => v !== null && v !== undefined);
        return {
            label: OPERATION_LABELS[op],
            mass: hasMass ? massTriple(o.gross_t, o.tare_t, o.net_t) : DASH,
            arrival: o.arrival || DASH,
            departure: o.departure || DASH,
            idle: o.idle || DASH,
        };
    });
}

export function cancelledLine(doc) {
    return doc.status === 'cancelled'
        ? 'АНУЛЬОВАНО' + (doc.cancelled_at ? ' ' + fmtDate(doc.cancelled_at) : '') + (doc.cancelled_reason ? ': ' + doc.cancelled_reason : '')
        : null;
}
