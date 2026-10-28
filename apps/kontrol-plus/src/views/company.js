// «Реквізити компанії»: той самий екран реквізитів (docs-requisites.js, логіка збереження без змін) у стилі 1С —
// рядки «підпис 160px | поле», ширина поля за змістом, картка по центру (стилі: .kpr-req у crm.css).
import { h } from '../ui.js';
import { docsAccess } from '../lib/docs.js';
import { renderRequisites } from './docs-requisites.js';

export function renderCompany(app) {
    const access = docsAccess(app.context);
    return h('section', { class: 'page kpr-page kpr-req' },
        h('div', { class: 'page-head' }, h('h1', null, 'Реквізити компанії')),
        renderRequisites(app, access));
}
