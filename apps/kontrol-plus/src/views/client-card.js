import { h, clear, spinner, notice, toast, confirmButton } from '../ui.js';
import { errorText, isPlanError } from '../lib/errors.js';
import { LEGAL_FORMS } from '../lib/validate.js';
import { fmtMoney, fmtNumber, fmtDate, num, STATUS_LABELS, kyivDate, monthRange } from '../lib/format.js';
import { DOC_KIND_LABELS, PAY_STATUS_LABELS, docNumberText, fmtAmount, isMissingFeature } from '../lib/docs.js';

const FORM_LABEL = Object.fromEntries(LEGAL_FORMS.map((f) => [f.value, f.label]));

// Реквізити текстом — для договору / рахунку (кнопка «Скопіювати реквізити»).
export function requisitesText(c) {
    const lines = [
        c.legal_name || c.name,
        c.edrpou ? 'ЄДРПОУ ' + c.edrpou : null,
        c.ipn ? 'ІПН ' + c.ipn : null,
        c.vat_payer ? 'ІПН платника ПДВ ' + (c.vat_number || '—') : 'Не є платником ПДВ',
        c.iban ? 'IBAN ' + c.iban + (c.bank_name ? ', ' + c.bank_name : '') : null,
        c.legal_address ? 'Юридична адреса: ' + c.legal_address : null,
        c.postal_address ? 'Поштова адреса: ' + c.postal_address : null,
        c.signer_name ? 'Підписант: ' + [c.signer_position, c.signer_name].filter(Boolean).join(' ') : null,
        c.phone ? 'Тел.: ' + c.phone : null,
        c.email ? 'Email: ' + c.email : null,
    ];
    return lines.filter(Boolean).join('\n');
}

function ibanGroups(iban) {
    return iban ? iban.replace(/(.{4})/g, '$1 ').trim() : null;
}

export function renderClientCard(app, clientId) {
    const head = h('div', null, spinner());
    const history = h('div', null);
    const docs = h('div', null);
    const linker = h('div', null);
    const page = h('section', { class: 'page' }, h('a', { class: 'back', href: '#/clients' }, '← Усі клієнти'), head, docs, history, linker);

    async function load() {
        const { data, error } = await app.supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
        if (error && isPlanError(error)) return app.onPlanLost();
        if (error || !data) {
            clear(head, notice(error ? errorText(error) : 'Клієнта не знайдено.'));
            return;
        }
        drawHead(data);
        loadDocs(data);
        loadHistory();
        if (app.canWrite && !data.archived_at) drawLinker();
    }

    function drawHead(c) {
        const row = (label, value, mono) => h('div', { class: 'kv' }, h('dt', null, label), h('dd', { class: mono ? 'mono' : null }, value || '—'));
        const archive = async (archivedAt) => {
            const { data, error } = await app.supabase.from('clients').update({ archived_at: archivedAt }).eq('id', clientId).select('id');
            if (error || !data || !data.length) return toast(error ? errorText(error) : 'Недостатньо прав', 'error');
            toast(archivedAt ? 'Клієнта перенесено в архів' : 'Клієнта повернуто з архіву');
            load();
        };
        const remove = async () => {
            const { data, error } = await app.supabase.from('clients').delete().eq('id', clientId).select('id');
            if (error || !data || !data.length) return toast(error ? errorText(error) : 'Видаляти клієнтів може лише власник', 'error');
            toast('Клієнта видалено');
            app.go('#/clients');
        };
        const copy = async () => {
            try {
                await navigator.clipboard.writeText(requisitesText(c));
                toast('Реквізити скопійовано');
            } catch {
                toast('Не вдалося скопіювати', 'error');
            }
        };

        clear(head,
            h('div', { class: 'page-head' },
                h('div', null,
                    h('h1', null, c.name, c.archived_at ? h('span', { class: 'tag' }, 'архів') : null),
                    h('p', { class: 'muted' }, [FORM_LABEL[c.legal_form], c.legal_name].filter(Boolean).join(' · ') || 'Форму не вказано')),
                h('div', { class: 'actions' },
                    app.canWrite && !c.archived_at ? h('a', { class: 'btn btn-primary', href: '#/docs/new/invoice/' + c.id }, 'Створити рахунок') : null,
                    app.canWrite && !c.archived_at ? h('a', { class: 'btn btn-primary', href: '#/docs/new/act/' + c.id }, 'Створити акт') : null,
                    h('button', { type: 'button', class: 'btn btn-ghost', onclick: copy }, 'Скопіювати реквізити'),
                    app.canWrite ? h('a', { class: 'btn', href: '#/clients/' + c.id + '/edit' }, 'Редагувати') : null,
                    app.canWrite ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => archive(c.archived_at ? null : new Date().toISOString()) },
                        c.archived_at ? 'Повернути з архіву' : 'В архів') : null,
                    app.canDelete ? confirmButton('Видалити', 'Точно видалити?', remove) : null)),
            h('div', { class: 'grid-2' },
                h('div', { class: 'card' }, h('h2', null, 'Реквізити'), h('dl', null,
                    row(c.legal_form === 'fop' ? 'ПІБ / назва' : 'Повна назва', c.legal_name),
                    row('ЄДРПОУ', c.edrpou, true),
                    row('ІПН / РНОКПП', c.ipn, true),
                    row('ПДВ', c.vat_payer ? 'Платник ПДВ' + (c.vat_number ? ', ІПН ' + c.vat_number : '') : 'Не платник'),
                    row('IBAN', ibanGroups(c.iban), true),
                    row('Банк', c.bank_name),
                    row('Юридична адреса', c.legal_address),
                    row('Поштова адреса', c.postal_address),
                    row('Підписант', [c.signer_position, c.signer_name].filter(Boolean).join(', ')),
                    'contract_no' in c ? row('Договір', c.contract_no ? '№ ' + c.contract_no + (c.contract_date ? ' від ' + fmtDate(c.contract_date) : '') : null) : null,
                    'payment_terms_days' in c ? row('Строк оплати', (c.payment_terms_days ?? 5) + ' дн.' + (c.payment_terms_days === null ? ' (за замовчуванням)' : '')) : null)),
                h('div', { class: 'card' }, h('h2', null, 'Контакт'), h('dl', null,
                    row('Контактна особа', c.contact_name),
                    row('Телефон', c.phone ? h('a', { href: 'tel:' + c.phone.replace(/[^\d+]/g, '') }, c.phone) : null),
                    row('Email', c.email ? h('a', { href: 'mailto:' + c.email }, c.email) : null),
                    row('Нотатки', c.notes ? h('span', { class: 'pre' }, c.notes) : null),
                    row('Додано', fmtDate(c.created_at))))));
    }

    // Документи клієнта за два роки і борг (етап 4a). Без міграції документів — розділу просто немає.
    async function loadDocs(client) {
        const today = kyivDate();
        const from = new Date(Date.parse(today + 'T00:00:00Z') - 720 * 86400000).toISOString().slice(0, 10);
        const [list, debts] = await Promise.all([
            app.supabase.rpc('kp_doc_list', { p_kind: null, p_from: from, p_to: today, p_client: clientId, p_status: null }),
            app.supabase.rpc('kp_client_debts', { p_on: null }),
        ]);
        if (list.error || debts.error) {
            if (!isMissingFeature(list.error || debts.error)) clear(docs, h('h2', { class: 'section-title' }, 'Документи'), notice(errorText(list.error || debts.error)));
            return;
        }
        const rows = list.data || [];
        const mine = (debts.data || []).filter((d) => d.client_id === clientId);
        clear(docs, h('h2', { class: 'section-title' }, 'Документи і борг'),
            mine.length ? h('div', { class: 'stats' }, mine.map((d) => [
                stat('Борг, ' + d.currency, fmtAmount(d.debt, d.currency)),
                stat('Прострочено, ' + d.currency, Number(d.overdue) > 0 ? fmtAmount(d.overdue, d.currency) + ' (' + d.overdue_days + ' дн.)' : '—')])) : null,
            rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-num' },
                h('thead', null, h('tr', null, h('th', null, 'Дата'), h('th', null, '№'), h('th', null, 'Тип'), h('th', null, 'Сума'), h('th', null, 'Борг'), h('th', null, 'Статус'))),
                h('tbody', null, rows.slice(0, 50).map((d) => h('tr', { class: d.status === 'cancelled' ? 'is-archived' : '' },
                    h('td', null, fmtDate(d.doc_date)),
                    h('td', { class: 'text' }, h('a', { href: '#/docs/' + d.id }, docNumberText(d))),
                    h('td', { class: 'text' }, DOC_KIND_LABELS[d.kind] || d.kind),
                    h('td', null, fmtAmount(d.total, d.currency)),
                    h('td', null, d.debt === null || d.debt === undefined ? '—' : fmtAmount(d.debt, d.currency)),
                    h('td', { class: 'text' }, PAY_STATUS_LABELS[d.pay_status] || d.pay_status))))))
                : h('p', { class: 'muted' }, 'Документів ще немає.' + (app.canWrite && !client.archived_at ? ' Створіть рахунок або акт кнопками вгорі.' : '')));
    }

    async function loadHistory() {
        clear(history, h('h2', { class: 'section-title' }, 'Історія рейсів і ставок'), spinner());
        const { data, error } = await app.supabase.rpc('client_history', { p_client: clientId });
        if (error) {
            if (isPlanError(error)) return app.onPlanLost();
            clear(history, h('h2', { class: 'section-title' }, 'Історія рейсів і ставок'), notice(errorText(error)));
            return;
        }
        drawHistory(data || []);
    }

    function drawHistory(rows) {
        const title = h('h2', { class: 'section-title' }, 'Історія рейсів і ставок');
        if (!rows.length) {
            clear(history, title, h('p', { class: 'muted' }, app.canWrite
                ? 'Рейсів ще немає. Привʼяжіть збережені на trip-control.com рейси нижче.'
                : 'Рейсів ще немає.'));
            return;
        }
        const sum = (key) => rows.reduce((s, r) => s + (num(r[key]) || 0), 0);
        const withFact = rows.filter((r) => r.fact_profit !== null);
        const rates = rows.map((r) => num(r.rate)).filter((v) => v !== null);
        const unlink = async (calcId) => {
            const { data, error } = await app.supabase.from('calculation_clients').delete().eq('calculation_id', calcId).select('calculation_id');
            if (error || !data || !data.length) return toast(error ? errorText(error) : 'Відвʼязати можна лише власний рейс', 'error');
            toast('Рейс відвʼязано');
            loadHistory();
            if (linker.firstChild) drawLinker();
        };
        clear(history, title,
            h('div', { class: 'stats' },
                stat('Рейсів', rows.length),
                stat('Дохід план', fmtMoney(sum('plan_revenue'))),
                stat('Прибуток план', fmtMoney(sum('plan_profit'))),
                stat('Прибуток факт', withFact.length ? fmtMoney(withFact.reduce((s, r) => s + num(r.fact_profit), 0)) + ` (${withFact.length})` : '—'),
                stat('Ставка: остання / середня', rates.length ? `${fmtNumber(rates[0])} / ${fmtNumber(rates.reduce((a, b) => a + b, 0) / rates.length)}` : '—')),
            h('div', { class: 'table-wrap' }, h('table', { class: 'table table-num' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Дата'), h('th', null, 'Рейс'), h('th', null, 'Статус'), h('th', null, 'Ставка'),
                    h('th', null, 'Км'), h('th', null, 'Т'), h('th', null, 'Дохід план'), h('th', null, 'Прибуток план'),
                    h('th', null, 'Дохід факт'), h('th', null, 'Прибуток факт'), h('th', null, 'Автор'), app.canWrite ? h('th', null, 'Документ') : null, app.canWrite ? h('th', null, '') : null)),
                h('tbody', null, rows.map((r) => h('tr', null,
                    h('td', null, fmtDate(r.trip_date)),
                    h('td', { class: 'text' }, r.name || [r.route_from, r.route_to].filter(Boolean).join(' — ') || '—'),
                    h('td', { class: 'text' }, h('span', { class: 'status status-' + r.status }, STATUS_LABELS[r.status] || r.status)),
                    h('td', null, fmtNumber(r.rate)),
                    h('td', null, fmtNumber(r.distance_km)),
                    h('td', null, fmtNumber(r.tonnage)),
                    h('td', null, fmtMoney(r.plan_revenue)),
                    h('td', null, fmtMoney(r.plan_profit)),
                    h('td', null, fmtMoney(r.fact_revenue)),
                    h('td', { class: deltaClass(r.fact_profit, r.plan_profit) }, fmtMoney(r.fact_profit)),
                    h('td', { class: 'text small' }, r.author_email || '—'),
                    app.canWrite ? h('td', { class: 'text small' }, h('a', { href: '#/docs/new/invoice/' + clientId + '/' + r.calculation_id }, 'Рахунок'), ' · ',
                        h('a', { href: '#/docs/new/act/' + clientId + '/' + r.calculation_id }, 'Акт')) : null,
                    app.canWrite ? h('td', null, confirmButton('Відвʼязати', 'Точно?', () => unlink(r.calculation_id), 'btn btn-ghost btn-sm')) : null))))));
    }

    function drawLinker() {
        const range = monthRange(kyivDate());
        const from = h('input', { type: 'date', value: range.from, 'aria-label': 'Рейси з' });
        const to = h('input', { type: 'date', value: range.to, 'aria-label': 'Рейси по' });
        const list = h('div', null);
        const load = async () => {
            clear(list, spinner());
            const { data, error } = await app.supabase.rpc('kp_trips', { p_from: from.value, p_to: to.value, p_only_unlinked: true });
            if (error) return clear(list, notice(errorText(error)));
            const rows = (data || []).filter((r) => r.can_link);
            if (!rows.length) return clear(list, h('p', { class: 'muted' }, 'За цей період немає непривʼязаних рейсів, доступних вам.'));
            clear(list, h('div', { class: 'table-wrap' }, h('table', { class: 'table table-num' },
                h('thead', null, h('tr', null, h('th', null, 'Дата'), h('th', null, 'Рейс'), h('th', null, 'Статус'),
                    h('th', null, 'Дохід план'), h('th', null, 'Прибуток план'), h('th', null, ''))),
                h('tbody', null, rows.map((r) => h('tr', null,
                    h('td', null, fmtDate(r.trip_date)),
                    h('td', { class: 'text' }, r.name || [r.route_from, r.route_to].filter(Boolean).join(' — ') || '—'),
                    h('td', { class: 'text' }, STATUS_LABELS[r.status] || r.status),
                    h('td', null, fmtMoney(r.plan_revenue)),
                    h('td', null, fmtMoney(r.plan_profit)),
                    h('td', null, h('button', {
                        type: 'button', class: 'btn btn-sm',
                        onclick: async (event) => {
                            const button = event.currentTarget;
                            button.disabled = true;
                            const { error: linkError } = await app.supabase.from('calculation_clients')
                                .insert({ calculation_id: r.calculation_id, client_id: clientId });
                            if (linkError) {
                                button.disabled = false;
                                return toast(errorText(linkError), 'error');
                            }
                            toast('Рейс привʼязано');
                            loadHistory();
                            load();
                        },
                    }, 'Привʼязати'))))))));
        };
        clear(linker,
            h('h2', { class: 'section-title' }, 'Привʼязати рейси'),
            h('p', { class: 'muted small' }, 'Рейси, збережені на trip-control.com. Логіст привʼязує свої рейси, власник — будь-які рейси організації.'),
            h('div', { class: 'toolbar' }, h('label', null, 'З ', from), h('label', null, 'по ', to),
                h('button', { type: 'button', class: 'btn', onclick: load }, 'Показати')),
            list);
        load();
    }

    load();
    return page;
}

function stat(label, value) {
    return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(value)));
}

function deltaClass(fact, plan) {
    const f = num(fact);
    const p = num(plan);
    if (f === null || p === null) return null;
    return f >= p ? 'pos' : 'neg';
}
