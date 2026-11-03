// Вікно «Заявка …» (PR 3 з 5): стислий огляд заявки з реєстру й кнопки наявних дій. Дані й дії дає сайт (index.html: kpRequestInfo,
// registryComplete / registryCancel, openSaved, openCalcDoc, openRegistryDoc, registrySetPaid) — тут лише розмітка; нової логіки немає.
import { h, clear, spinner, notice } from '../ui.js';

const call = (name, ...args) => (typeof window !== 'undefined' && typeof window[name] === 'function' ? window[name](...args) : undefined);

function fact(label, value, mono) {
    return h('div', { class: 'kp-req-fact' }, h('small', null, label), h('b', { class: mono ? 'kp-mono' : '' }, value === null || value === undefined || value === '' ? '—' : value));
}

function docLinks(docs, kind) {
    const list = (docs || []).filter((d) => d.kind === kind);
    if (!list.length) return h('span', { class: 'kp-reg-none' }, '—');
    return list.map((d, i) => [i ? ', ' : null, h('a', { class: 'kp-reg-doc kp-mono', href: '#/docs/' + encodeURIComponent(d.id) }, d.number),
        h('small', { class: 'kp-reg-doc-st' + (d.status === 'cancelled' ? ' is-cancelled' : '') }, d.status === 'cancelled' ? 'анульований' : 'виданий')]);
}

export function drawRequest(info, ctl, redraw) {
    const buttons = [];
    const act = (label, onclick, cls) => buttons.push(h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick }, label));
    act('Відкрити в калькуляторі', () => { ctl.close({ force: true }).then(() => call('openSaved', info.id)); }, 'btn-primary');
    if (info.can && info.can.complete) act('Виконана', async () => { await call('registryComplete', info.id); redraw(); }, '');
    if (info.can && info.can.cancel) act('Скасувати', async () => { await call('registryCancel', info.id); redraw(); }, 'btn-danger');
    for (const a of info.actions || []) {
        if (a.kind === 'create') act(a.label, () => call('openCalcDoc', a.docKind, info.id), '');
        else if (a.kind === 'open') act(a.label, () => call('openRegistryDoc', a.doc), '');
        else act(a.label, async () => { await call('registrySetPaid', a.doc, a.paid); redraw(); }, '');
    }
    return h('div', { class: 'kp-req' },
        h('div', { class: 'page-head' }, h('div', null,
            h('h2', null, 'Заявка ' + (info.registry_no || '')),
            h('p', { class: 'muted' }, info.route))),
        h('div', { class: 'kp-req-grid' },
            fact('Статус', info.statusLabel), fact('Дата рейсу', info.date, true), fact('Клієнт', info.client), fact('Авто', info.vehicles, true),
            info.user ? fact('Логіст', info.user) : null,
            fact('Км', info.km, true), fact('Виручка', info.revenue, true), fact('Прибуток план', info.profit, true),
            h('div', { class: 'kp-req-fact' }, h('small', null, 'Прибуток факт'),
                h('b', { class: 'kp-mono kp-fact' + (info.factState === 'ok' ? ' is-ok' : info.factState === 'low' ? ' is-low' : '') }, info.fact || '—'))),
        info.cancelReason ? h('p', { class: 'kp-req-cancel' }, 'Скасовано: ' + info.cancelReason) : null,
        h('div', { class: 'kp-req-docs' },
            h('div', { class: 'kp-req-fact' }, h('small', null, 'Договір'),
                info.contract ? (info.client_id ? h('a', { class: 'kp-reg-doc kp-mono', href: '#/clients/' + encodeURIComponent(info.client_id) }, info.contract) : h('b', { class: 'kp-mono' }, info.contract)) : h('span', { class: 'kp-reg-none' }, '—')),
            h('div', { class: 'kp-req-fact' }, h('small', null, 'Рахунок'), docLinks(info.docs, 'invoice')),
            h('div', { class: 'kp-req-fact' }, h('small', null, 'Акт'), docLinks(info.docs, 'act')),
            h('div', { class: 'kp-req-fact' }, h('small', null, 'Оплата'), info.payLabel ? h('b', { class: 'kp-pay is-' + info.payState }, info.payLabel) : h('span', { class: 'kp-reg-none' }, '—'))),
        h('div', { class: 'kp-req-actions' }, buttons));
}

// Монтує вміст у контейнер вікна; після дії (виконана / скасувати / оплата) перемальовує себе свіжими даними.
export async function renderRequestWindow(container, id, ctl) {
    async function draw() {
        clear(container, spinner());
        let info = null;
        try { info = await call('kpRequestInfo', id); } catch { info = null; }
        if (!container.isConnected && container.isConnected !== undefined) return;
        if (!info) { clear(container, h('section', { class: 'page' }, notice('Заявку не знайдено в історії.', 'info'))); return; }
        ctl.setTitle('Заявка ' + (info.registry_no || ''));
        clear(container, drawRequest(info, ctl, draw));
    }
    await draw();
}
