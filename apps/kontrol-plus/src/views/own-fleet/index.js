// «Власний парк» (етап 1): точка входу lazy-чанку. Підключається з bridge.js лише коли own_fleet_context() повернув доступ
// (прапорець own_fleet в організації), тому в організацій без прапорця цей код навіть не завантажується.
import '../../kp-own-fleet.css';
import { h, notice } from '../../ui.js';
import { OWN_FLEET_ROLE_LABELS } from '../../lib/own-fleet.js';
import { ownFleetAccess } from '../../lib/own-fleet-gate.js';
import { renderBoard, renderRequesterList } from './board.js';
import { renderRequestCard, renderRequestForm } from './request-card.js';
import { renderPointCard, renderPointsList, renderUnitCard, renderUnitsList } from './units.js';
import { renderRequestersBlock } from './requesters.js';

// Блок «Замовники підрозділів» для вкладки «Команда» кабінету (bridge.js вставляє його лише директору / менеджеру з прапорцем own_fleet).
export { renderRequestersBlock };

const TABS = [
    { sub: 'board', hash: '#/own-fleet', label: 'Дошка' },
    { sub: 'list', hash: '#/own-fleet/list', label: 'Заявки' },
    { sub: 'units', hash: '#/own-fleet/units', label: 'Підрозділи' },
    { sub: 'points', hash: '#/own-fleet/points', label: 'Поля й точки' },
];

function tabs(sub) {
    return h('nav', { class: 'kpr-tabs', 'aria-label': 'Розділи «Власного парку»' }, TABS.map((t) =>
        h('a', { href: t.hash, class: 'kpr-tab' + (t.sub === sub ? ' on' : ''), 'aria-current': t.sub === sub ? 'page' : null }, t.label)));
}

function appWithAccess(app) {
    return { access: ownFleetAccess(app.ownFleet), app };
}

// Розділ (сторінка): дошка / список / підрозділи / точки; замовник підрозділу — лише свої заявки. Картки на вузькому екрані — теж сторінкою.
export function renderOwnFleet(app, route) {
    const { access } = appWithAccess(app);
    if (!access.enabled) return h('section', { class: 'page' }, notice('Розділ «Власний парк» не ввімкнено для вашої компанії.', 'info'));
    if (route.view === 'own-fleet-card') {
        return h('section', { class: 'page kpof kpr-page kpg-page' }, h('a', { class: 'back', href: route.kind === 'unit' ? '#/own-fleet/units' : route.kind === 'point' ? '#/own-fleet/points' : '#/own-fleet' }, '← Назад'),
            renderOwnFleetCard({ ...app, closeWindow: undefined }, route.kind, route.id));
    }
    const title = h('div', { class: 'kpof-title-row' }, h('h1', { class: 'kpof-h1' }, 'Власний парк'), h('span', { class: 'badge kpof-role' }, OWN_FLEET_ROLE_LABELS[access.role]));
    if (access.isRequester) return h('section', { class: 'page kpof' }, title, h('h2', { class: 'kpof-sub' }, 'Заявки'), renderRequesterList(app, access));
    const sub = route.sub || 'board';
    let body;
    if (sub === 'units') body = renderUnitsList(app);
    else if (sub === 'points') body = renderPointsList(app);
    else body = renderBoard(app, access, sub === 'list' ? 'list' : 'board');
    return h('section', { class: 'page kpof' }, title, tabs(sub), body);
}

// Картка у вікні (kind: request | unit | point; id null — створення).
export function renderOwnFleetCard(app, kind, id) {
    const access = ownFleetAccess(app.ownFleet);
    const wrap = (child) => h('div', { class: 'kpof kpof-card-wrap' }, child);
    if (!access.enabled) return wrap(notice('Розділ «Власний парк» не ввімкнено для вашої компанії.', 'info'));
    if (kind === 'request') return wrap(id ? renderRequestCard(app, access, id) : renderRequestForm(app, access));
    if (!access.canManage) return wrap(notice('Підрозділи й точки редагують директор, менеджер і логіст.', 'info'));
    if (kind === 'unit') return wrap(renderUnitCard(app, id));
    if (kind === 'point') return wrap(renderPointCard(app, id));
    return wrap(notice('Не вдалося відкрити картку.'));
}

