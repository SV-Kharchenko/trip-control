import { h } from '../ui.js';

// Без тарифу Контроль+ — лише пояснення і посилання на сайт. Оплати в застосунку немає.
export function renderPaywall({ context, siteUrl }) {
    return h('section', { class: 'page narrow paywall' },
        h('div', { class: 'card' },
            h('h1', null, 'Цей розділ доступний у тарифі Контроль+'),
            h('p', null, context && context.org_name
                ? `Організація «${context.org_name}» зараз без тарифу Контроль+.`
                : 'Ваш акаунт ще не привʼязано до організації з тарифом Контроль+.'),
            h('ul', { class: 'ticks' },
                h('li', null, 'Клієнти з реквізитами ТОВ / ФОП'),
                h('li', null, 'Історія рейсів і ставок по кожному клієнту'),
                h('li', null, 'Звіт план/факт по логістах, авто, клієнтах і напрямках'),
                h('li', null, 'Доступ директора лише на перегляд')),
            h('a', { class: 'btn btn-primary', href: siteUrl + '/', target: '_blank', rel: 'noopener' }, 'Дізнатися більше на trip-control.com')));
}
