// Підсумки документа окремими рядками праворуч: «Без ПДВ / ПДВ 20 % / Всього» (підпис і значення не злипаються).
import { h } from '../ui.js';

export function totalRow(label, value, cls) {
    return h('div', { class: 'kpd-total-row' + (cls ? ' ' + cls : '') }, h('span', { class: 'kpd-total-label' }, label), h('b', { class: 'kpd-total-value' }, value));
}

// vat — документ з ПДВ; vatLabel — підпис рядка ПДВ (напр. «ПДВ 20 %»).
export function totalRows({ vat, subtotal, vatAmount, total, vatLabel = 'ПДВ 20 %' }) {
    return [
        totalRow(vat ? 'Без ПДВ' : 'Разом', subtotal),
        vat ? totalRow(vatLabel, vatAmount) : h('div', { class: 'kpd-total-row muted' }, h('span', { class: 'kpd-total-label' }, 'Без ПДВ')),
        totalRow('Всього', total, 'is-grand'),
    ];
}
