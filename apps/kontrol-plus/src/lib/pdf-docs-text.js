// Тексти документа (сторони, договір, курс, підсумки, сума прописом) — спільні для картки документа і PDF.
// Без pdf-lib: картка не тягне PDF-бібліотеку в основний бандл.
import { amountInWords } from './amount-words.js';
import { fmtDate } from './format.js';
import { fmtAmount, fmtMoneyPlain, fmtRate } from './docs.js';

export function partyLines(p, { contract } = {}) {
    if (!p) return [];
    const codes = [p.edrpou ? 'Код ЄДРПОУ ' + p.edrpou : null, p.ipn ? 'РНОКПП ' + p.ipn : null].filter(Boolean).join(', ');
    return [
        p.legal_name || p.name || '—',
        codes || null,
        p.iban ? 'IBAN ' + p.iban + (p.bank_name ? ', ' + p.bank_name : '') : null,
        p.legal_address ? 'Адреса: ' + p.legal_address : null,
        p.vat_payer ? 'Платник ПДВ' + (p.vat_number ? ', ІПН ' + p.vat_number : '') : 'Не є платником ПДВ',
        contract && p.contract_no ? 'Договір № ' + p.contract_no + (p.contract_date ? ' від ' + fmtDate(p.contract_date) : '') : null,
    ].filter(Boolean);
}

export function contractText(buyer) {
    return buyer && buyer.contract_no ? '№ ' + buyer.contract_no + (buyer.contract_date ? ' від ' + fmtDate(buyer.contract_date) : '') : null;
}

export function rateLine(doc) {
    if (!doc || doc.currency === 'UAH') return null;
    return `Курс НБУ на ${fmtDate(doc.rate_date)}: 1 ${doc.currency} = ${fmtRate(doc.rate)} грн; еквівалент ${fmtMoneyPlain(doc.total_uah)} грн`;
}

export function totalsRows(doc) {
    if (Number(doc.vat_rate) !== 20) {
        return [['Разом:', fmtAmount(doc.subtotal, doc.currency)], ['ПДВ:', 'Без ПДВ'], ['Всього:', fmtAmount(doc.total, doc.currency)]];
    }
    return [
        ['Разом без ПДВ:', fmtAmount(doc.subtotal, doc.currency)],
        ['ПДВ 20 %:', fmtAmount(doc.vat_amount, doc.currency)],
        ['Всього з ПДВ:', fmtAmount(doc.total, doc.currency)],
    ];
}

export function totalWords(doc) {
    const words = amountInWords(doc.total, doc.currency);
    return Number(doc.vat_rate) === 20 ? `${words}, у т.ч. ПДВ ${fmtAmount(doc.vat_amount, doc.currency)}` : `${words}, без ПДВ`;
}
