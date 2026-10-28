// «Реквізити» — вкладка «Особистого кабінету» (сайт: #cab-req-slot, див. fillCabinetSlot у bridge.js). Той самий екран реквізитів
// (docs-requisites.js, логіка збереження без змін) у стилі 1С — рядки «підпис 160px | поле», ширина поля за змістом
// (стилі: .kpr-req у crm.css, для слота — згенерований cabinet-slot.css). Змінює лише директор; логіст бачить реквізити для перегляду.
import { h } from '../ui.js';
import { docsAccess } from '../lib/docs.js';
import { renderRequisites } from './docs-requisites.js';

export function renderCabinetRequisites(app) {
    const access = docsAccess(app.context);
    return h('section', { class: 'page kpr-page kpr-req' }, renderRequisites(app, access));
}
