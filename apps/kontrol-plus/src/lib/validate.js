// Реквізити клієнта. Формат (довжина, цифри, UA-IBAN, email) перевіряє і база (CHECK) — тут це помилки, що блокують
// збереження. Контрольні цифри ЄДРПОУ / ІПН / IBAN — лише попередження: старі коди й рідкісні винятки трапляються,
// тож рішення лишається за людиною.

export const LEGAL_FORMS = [
    { value: 'tov', label: 'ТОВ' },
    { value: 'fop', label: 'ФОП' },
    { value: 'other', label: 'Інша форма' },
];

export function digitsOnly(value) {
    return String(value == null ? '' : value).replace(/\D+/g, '');
}

export function normalizeIban(value) {
    return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
}

// ЄДРПОУ: 8 цифр, контрольна цифра — сума цифр з вагами mod 11 (ваги залежать від діапазону коду).
export function edrpouChecksumOk(code) {
    if (!/^[0-9]{8}$/.test(code)) return false;
    const d = code.split('').map(Number);
    const n = Number(code);
    const base = n < 30000000 || n > 60000000 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
    const sum = (weights) => weights.reduce((s, w, i) => s + w * d[i], 0) % 11;
    let check = sum(base);
    if (check === 10) {
        check = sum(base.map((w) => w + 2));
        if (check === 10) check = 0;
    }
    return check === d[7];
}

// ІПН (РНОКПП) фізособи: 10 цифр, ваги −1 5 7 9 4 6 10 5 7, (сума mod 11) mod 10 = десята цифра.
export function ipnChecksumOk(code) {
    if (!/^[0-9]{10}$/.test(code)) return false;
    const d = code.split('').map(Number);
    const weights = [-1, 5, 7, 9, 4, 6, 10, 5, 7];
    const sum = weights.reduce((s, w, i) => s + w * d[i], 0);
    return ((sum % 11) + 11) % 11 % 10 === d[9];
}

// IBAN mod-97 (ISO 13616): перші 4 символи в кінець, літери → числа, остача від 97 має бути 1.
export function ibanChecksumOk(iban) {
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
    const moved = iban.slice(4) + iban.slice(0, 4);
    let rest = 0;
    for (const ch of moved) {
        const part = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
        for (const digit of part) rest = (rest * 10 + Number(digit)) % 97;
    }
    return rest === 1;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Договір і строк оплати (етап 4a, міграція *_kp_documents.sql): колонки clients, яких до міграції ще немає.
export const CONTRACT_KEYS = ['contract_no', 'contract_date', 'payment_terms_days'];

function clean(value) {
    const text = String(value == null ? '' : value).trim();
    return text === '' ? null : text;
}

// Повертає { data, errors, warnings }: data — рядок для clients (порожнє → null), errors/warnings — { поле: текст }.
export function validateClient(input) {
    const errors = {};
    const warnings = {};
    const data = {
        name: clean(input.name),
        legal_name: clean(input.legal_name),
        legal_form: clean(input.legal_form),
        edrpou: clean(digitsOnly(input.edrpou)),
        ipn: clean(digitsOnly(input.ipn)),
        vat_payer: Boolean(input.vat_payer),
        vat_number: clean(digitsOnly(input.vat_number)),
        iban: clean(normalizeIban(input.iban)),
        bank_name: clean(input.bank_name),
        legal_address: clean(input.legal_address),
        postal_address: clean(input.postal_address),
        signer_name: clean(input.signer_name),
        signer_position: clean(input.signer_position),
        contact_name: clean(input.contact_name),
        phone: clean(input.phone),
        email: clean(input.email) && clean(input.email).toLowerCase(),
        notes: clean(input.notes),
        contract_no: clean(input.contract_no),
        contract_date: clean(input.contract_date),
        payment_terms_days: clean(input.payment_terms_days),
    };

    if (!data.name) errors.name = 'Вкажіть назву клієнта';
    else if (data.name.length > 200) errors.name = 'Назва довша за 200 символів';
    if (data.legal_form && !LEGAL_FORMS.some((f) => f.value === data.legal_form)) errors.legal_form = 'Невідома форма';

    if (data.edrpou) {
        if (data.edrpou.length !== 8) errors.edrpou = 'ЄДРПОУ — 8 цифр';
        else if (!edrpouChecksumOk(data.edrpou)) warnings.edrpou = 'Контрольна цифра ЄДРПОУ не збігається — перевірте код';
    }
    if (data.ipn) {
        if (data.ipn.length !== 10) errors.ipn = 'ІПН (РНОКПП) — 10 цифр';
        else if (!ipnChecksumOk(data.ipn)) warnings.ipn = 'Контрольна цифра ІПН не збігається — перевірте номер';
    }
    if (data.vat_number && data.vat_number.length !== 10 && data.vat_number.length !== 12) {
        errors.vat_number = 'Номер платника ПДВ — 10 або 12 цифр';
    }
    if (data.vat_payer && !data.vat_number) warnings.vat_number = 'Платник ПДВ без ІПН платника ПДВ';
    if (data.iban) {
        if (!/^UA[0-9]{27}$/.test(data.iban)) errors.iban = 'IBAN України: UA і 27 цифр';
        else if (!ibanChecksumOk(data.iban)) warnings.iban = 'Контрольна сума IBAN не збігається — перевірте рахунок';
    }
    if (data.email && !EMAIL.test(data.email)) errors.email = 'Некоректний email';
    if (data.notes && data.notes.length > 4000) errors.notes = 'Нотатки довші за 4000 символів';
    if (data.contract_no && data.contract_no.length > 100) errors.contract_no = 'Номер договору — до 100 символів';
    if (data.contract_date && (!/^\d{4}-\d{2}-\d{2}$/.test(data.contract_date) || data.contract_date < '1991-01-01' || data.contract_date > '2100-12-31')) {
        errors.contract_date = 'Некоректна дата договору';
    }
    if (data.payment_terms_days !== null) {
        const days = Number(data.payment_terms_days);
        if (!Number.isInteger(days) || days < 0 || days > 365) errors.payment_terms_days = 'Строк оплати — ціле число від 0 до 365 днів';
        else data.payment_terms_days = days;
    }

    if (data.legal_form === 'tov' && !data.edrpou) warnings.edrpou = warnings.edrpou || 'Для ТОВ зазвичай потрібен ЄДРПОУ';
    if (data.legal_form === 'fop' && !data.ipn) warnings.ipn = warnings.ipn || 'Для ФОП зазвичай потрібен ІПН';

    return { data, errors, warnings };
}
