// Чисті функції мобільної оболонки Контроль+ (PR 5 з 5): межа телефона, свайп шторки, «← Назад», лічильник фільтрів. Без DOM — їх перевіряють тести.
import { cardParentHash, parseCrmHash, windowSpecOf } from './route.js';

export const MOBILE_MAX = 899; // вужче — меню-шторка, повноекранні картки замість вікон
export const CARDS_MAX = 699; // вужче — рядки таблиць стають картками, фільтри ховаються в панель
export const EDGE_PX = 24; // свайп вправо відкриває шторку лише від лівого краю
export const SWIPE_PX = 60; // мінімальний горизонтальний зсув свайпу

// Що робить свайп: 'close' — шторка відкрита і свайп вліво; 'open' — шторка закрита, свайп вправо від лівого краю; null — нічого.
export function swipeAction({ dx, dy, startX, open }) {
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
    if (open && dx < 0) return 'close';
    if (!open && dx > 0 && startX <= EDGE_PX) return 'open';
    return null;
}

// «← Назад» потрібен на сторінках карток і форм (маршрути, що на комп'ютері відкриваються вікном).
export function isBackRoute(hash) {
    const route = parseCrmHash(hash);
    return !!route && windowSpecOf(route, hash) !== null;
}

// Куди повертатись, якщо історії немає: список розділу картки.
export function backFallback(hash) {
    const route = parseCrmHash(hash);
    const parent = cardParentHash(route);
    if (parent) return parent;
    if (!route) return '#/clients';
    if (route.view === 'docs') return route.kind === 'ttn' || route.sub === 'ttn' ? '#/docs/tab/ttn' : route.kind === 'trip_sheet' || route.sub === 'trip_sheet' ? '#/docs/tab/trip_sheets'
        : route.kind === 'act' ? '#/docs/tab/acts' : route.kind === 'invoice' ? '#/docs/tab/invoices' : '#/docs';
    if (route.view === 'request') return '#/dashboard';
    return '#/clients';
}

// Скільки фільтрів змінено відносно початкового стану: [{ value, initial, type, checked, initialChecked }].
export function filterCount(controls) {
    let n = 0;
    for (const c of controls || []) {
        if (c.type === 'checkbox' || c.type === 'radio') { if (!!c.checked !== !!c.initialChecked) n += 1; } else if (String(c.value || '') !== String(c.initial || '')) n += 1;
    }
    return n;
}
