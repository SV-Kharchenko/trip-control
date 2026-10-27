// «Водії»: список і додавання водіїв з даних, що вже є (kp_driver_list / kp_driver_save, міграція 4b) — без нових таблиць.
// Немає водіїв і немає права писати — порожній стан «Скоро тут будуть водії».
import { h } from '../ui.js';
import { docsAccess } from '../lib/docs.js';
import { renderFleet } from './docs-fleet.js';

export function renderDrivers(app) {
    const access = docsAccess(app.context);
    return h('section', { class: 'page kpr-page' },
        h('div', { class: 'page-head' }, h('h1', null, 'Водії')),
        renderFleet(app, access, 'drivers'));
}
