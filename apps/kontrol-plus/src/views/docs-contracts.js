// Вкладка «Документи» → «Договори»: реєстр договорів усіх контрагентів (kp_contract_list_all) з фільтрами за клієнтом, періодом і
// статусом «діє / закінчився / анульовано», бейдж «закінчується за 30 днів». Дані й сховище ті самі, що в картці контрагента (#89):
// таблиця kp_contracts, приватний бакет kp-contracts, підписання (печатка / КЕП) і відправка — в картці клієнта.
// «Додати договір» — лише тут; скан — PDF / JPG / PNG, відкриття через підписане посилання. Анулює лише власник.
import { h, clear, spinner, notice, toast } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { callKpApi } from '../lib/gps-client.js';
import {
    CONTRACT_BUCKET, CONTRACT_STATUS, contractErrorText, contractLabel, contractPath, extOf, scanContentType, scanProblem,
} from '../lib/contracts.js';
import { contractCancelErrorText } from '../lib/other-docs.js';
import { statusOptions, validityBadge } from '../lib/docs-tabs.js';
import { isMissingFeature } from '../lib/docs.js';
import { openSigned, reasonCancel } from './docs-other.js';

const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12));
const labeled = (text, control) => h('label', { class: 'kpd-f' }, h('span', null, text), control);
const field = (label, id, control) => h('div', { class: 'field' }, h('label', { for: id }, label), control);

export function renderContractsTab(app, access) {
    const from = h('input', { type: 'date', 'aria-label': 'Період з' });
    const to = h('input', { type: 'date', 'aria-label': 'Період по' });
    const status = h('select', { 'aria-label': 'Статус' }, statusOptions('contracts').map(([v, l]) => h('option', { value: v }, l)));
    const client = h('select', { 'aria-label': 'Клієнт' }, h('option', { value: '' }, 'Усі клієнти'));
    const list = h('div', { class: 'list' }, spinner());
    const formBox = h('div');
    let clients = null;

    async function loadClients() {
        if (clients) return clients;
        const { data } = await app.supabase.from('clients').select('id, name, archived_at').order('name', { ascending: true }).limit(2000);
        clients = data || [];
        return clients;
    }

    async function load() {
        if (from.value && to.value && from.value > to.value) {
            clear(list, notice('Перевірте період: «з» не пізніше «по».'));
            return;
        }
        clear(list, spinner());
        const { data, error } = await app.supabase.rpc('kp_contract_list_all', {
            p_client: client.value || null, p_from: from.value || null, p_to: to.value || null, p_status: status.value || null,
        });
        if (error) {
            clear(list, isMissingFeature(error) ? notice('Договори ще не ввімкнено для вашої компанії (міграцію бази не застосовано).', 'info') : notice(contractErrorText(error)));
            return;
        }
        const rows = data || [];
        if (!rows.length) {
            clear(list, h('div', { class: 'empty' }, h('b', null, 'Договорів ще немає'),
                h('p', { class: 'muted' }, 'Договір із клієнтом з’явиться тут і підтягне реквізити компанії.' + (access.canWrite ? ' Додайте перший кнопкою вгорі.' : ''))));
            return;
        }
        clear(list, h('div', { class: 'table-wrap kpr-cards' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Дата', 'Договір', 'Клієнт', 'Предмет', 'Діє до', 'Статус', ''].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((r) => {
                const badge = validityBadge(r);
                return h('tr', { class: r.status === 'cancelled' ? 'is-archived' : '' },
                    h('td', { 'data-label': 'Дата' }, fmtDate(r.contract_date)),
                    h('td', { 'data-label': 'Договір' }, h('b', null, contractLabel(r)),
                        r.cancel_reason ? h('div', { class: 'muted small' }, 'Причина анулювання: ' + r.cancel_reason) : null),
                    h('td', { 'data-label': 'Клієнт' }, h('a', { href: '#/clients/' + r.client_id }, r.client_name || '—')),
                    h('td', { 'data-label': 'Предмет' }, r.subject || '—'),
                    h('td', { 'data-label': 'Діє до' }, r.valid_until ? fmtDate(r.valid_until) : '—'),
                    h('td', { 'data-label': 'Статус' }, h('span', { class: 'kpd-st kpd-st-' + badge.key }, badge.label),
                        r.status === 'signed' || r.status === 'sent' ? h('span', { class: 'muted small' }, ' · ' + CONTRACT_STATUS[r.status]) : null),
                    h('td', { 'data-label': '' }, h('div', { class: 'actions' },
                        r.file_path ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openSigned(app, CONTRACT_BUCKET, r.file_path, contractErrorText) }, 'Скан') : null,
                        r.signed_path ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openSigned(app, CONTRACT_BUCKET, r.signed_path, contractErrorText) }, 'Підписана копія') : null,
                        h('a', { class: 'btn btn-sm btn-ghost', href: '#/clients/' + r.client_id }, 'У картці клієнта'),
                        access.isOwner && r.status !== 'cancelled'
                            ? reasonCancel((reason) => app.supabase.rpc('kp_contract_cancel', { p_id: r.id, p_reason: reason }), load, contractCancelErrorText) : null)));
            })))));
    }

    async function openForm() {
        const all = (await loadClients()).filter((c) => !c.archived_at);
        const f = {
            client: h('select', { id: 'kpt-client' }, h('option', { value: '' }, 'Оберіть контрагента'), all.map((c) => h('option', { value: c.id }, c.name))),
            number: h('input', { type: 'text', id: 'kpt-number', maxlength: 100 }),
            subject: h('input', { type: 'text', id: 'kpt-subject', maxlength: 500 }),
            date: h('input', { type: 'date', id: 'kpt-date' }),
            valid: h('input', { type: 'date', id: 'kpt-valid' }),
            file: h('input', { type: 'file', id: 'kpt-file', accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' }),
        };
        const status2 = h('div', { 'aria-live': 'polite' });
        const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Зберегти');
        save.onclick = async () => {
            const file = f.file.files && f.file.files[0];
            if (!f.client.value) return clear(status2, notice('Оберіть контрагента.'));
            if (!f.number.value.trim() || !f.date.value) return clear(status2, notice('Вкажіть номер і дату договору.'));
            if (f.valid.value && f.valid.value < f.date.value) return clear(status2, notice('Строк дії не може бути раніше дати договору.'));
            const problem = file ? scanProblem(file) : null;
            if (problem) return clear(status2, notice(problem));
            save.disabled = true;
            const { data: id, error } = await app.supabase.rpc('kp_contract_save', {
                p_id: null, p_client: f.client.value,
                p_data: { number: f.number.value.trim(), contract_date: f.date.value, subject: f.subject.value.trim(), valid_until: f.valid.value || '' },
            });
            if (error) {
                save.disabled = false;
                return clear(status2, notice(contractErrorText(error)));
            }
            let scanNote = null;
            if (file) {
                const path = contractPath(app.context && app.context.org_id, id, 'scan', extOf(file.name), uuid());
                const up = await app.supabase.storage.from(CONTRACT_BUCKET).upload(path, file, { contentType: scanContentType(file), upsert: false });
                const out = up.error ? { ok: false, error: contractErrorText(up.error) } : await callKpApi(app, '/api/contracts/sign', { contract_id: id, method: 'scan', path, name: file.name });
                if (!out.ok) scanNote = out.error || 'Не вдалося прийняти скан';
            }
            save.disabled = false;
            clear(formBox);
            toast(scanNote ? 'Договір додано, але скан не завантажено: ' + scanNote + '. Додайте його в картці клієнта.' : 'Договір додано', scanNote ? 'error' : undefined);
            return load();
        };
        clear(formBox, h('div', { class: 'card kpk-form' }, h('h3', null, 'Новий договір'),
            h('div', { class: 'form' },
                field('Контрагент', 'kpt-client', f.client), field('Номер / назва', 'kpt-number', f.number), field('Предмет (необов’язково)', 'kpt-subject', f.subject),
                field('Дата договору', 'kpt-date', f.date), field('Діє до (необов’язково)', 'kpt-valid', f.valid),
                field('Скан (PDF, JPG, PNG до 10 МБ)', 'kpt-file', f.file), status2,
                h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => clear(formBox) }, 'Скасувати')))));
    }

    async function fillClients() {
        for (const c of await loadClients()) client.append(h('option', { value: c.id }, c.name + (c.archived_at ? ' (архів)' : '')));
    }

    for (const el of [from, to, status, client]) el.addEventListener('change', load);
    fillClients().then(load, load);
    return h('div', null,
        h('div', { class: 'toolbar kpd-filters' }, labeled('Період з', from), labeled('по', to), labeled('Статус', status), labeled('Клієнт', client)),
        access.canWrite ? h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: openForm }, 'Додати договір')) : null,
        formBox, list);
}
