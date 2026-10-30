// Розділ «Договори» в картці контрагента: реєстр (номер, дата, предмет, строк, статус), скан у приватному сховищі (доступ лише
// через підписані посилання на 10 хв), підпис зображеннями підпису й печатки АБО КЕП (.p7s), відправка контрагенту.
// Права («Договори», «Підпис і печатка») перевіряє сервер; тут лише повідомлення про відмову. Кнопки — за розміром тексту.
import { h, clear, spinner, notice, toast } from '../ui.js';
import { fmtDate } from '../lib/format.js';
import { callKpApi } from '../lib/gps-client.js';
import {
    CONTRACT_BUCKET, CONTRACT_STATUS, SIGNED_URL_SECONDS, attachmentNames, contractErrorText, contractLabel, contractPath, extOf,
    scanContentType, scanProblem, sigProblem,
} from '../lib/contracts.js';
import { kepWidgetReady, openKepWidget } from '../lib/kep-widget.js';
import { emailControl } from './doc-email.js';
import { isMissingFeature } from '../lib/docs.js';

const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12));

export function renderContracts(app, client) {
    const box = h('div', { class: 'kpk-contracts' }, spinner());
    const writable = app.canWrite && !client.archived_at;
    let kep = null;
    let editing = null;

    async function load() {
        const { data, error } = await app.supabase.rpc('kp_contract_list', { p_client: client.id });
        if (error && isMissingFeature(error)) return clear(box);
        if (error) return clear(box, h('h2', { class: 'section-title' }, 'Договори'), notice(contractErrorText(error)));
        draw(data || []);
    }

    async function signedUrl(path) {
        const { data, error } = await app.supabase.storage.from(CONTRACT_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
        if (error || !data || !data.signedUrl) return toast(contractErrorText(error) || 'Не вдалося відкрити файл', 'error');
        window.open(data.signedUrl, '_blank', 'noopener');
    }

    function form(c) {
        const f = {
            number: h('input', { type: 'text', id: 'kpc-number', maxlength: 100, value: c ? c.number : '' }),
            date: h('input', { type: 'date', id: 'kpc-date', value: c ? c.contract_date : '' }),
            subject: h('input', { type: 'text', id: 'kpc-subject', maxlength: 500, value: (c && c.subject) || '' }),
            valid: h('input', { type: 'date', id: 'kpc-valid', value: (c && c.valid_until) || '' }),
        };
        const status = h('div', { 'aria-live': 'polite' });
        const field = (label, id, control) => h('div', { class: 'field' }, h('label', { for: id }, label), control);
        const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Зберегти');
        save.onclick = async () => {
            if (!f.number.value.trim() || !f.date.value) return clear(status, notice('Вкажіть номер і дату договору.'));
            save.disabled = true;
            const { error } = await app.supabase.rpc('kp_contract_save', {
                p_id: c ? c.id : null, p_client: client.id,
                p_data: { number: f.number.value.trim(), contract_date: f.date.value, subject: f.subject.value.trim(), valid_until: f.valid.value || '' },
            });
            save.disabled = false;
            if (error) return clear(status, notice(contractErrorText(error)));
            editing = null;
            toast(c ? 'Договір збережено' : 'Договір додано');
            load();
        };
        return h('div', { class: 'card kpk-form' }, h('h3', null, c ? 'Змінити договір' : 'Новий договір'),
            h('div', { class: 'form' }, field('Номер', 'kpc-number', f.number), field('Дата', 'kpc-date', f.date),
                field('Предмет', 'kpc-subject', f.subject), field('Діє до', 'kpc-valid', f.valid), status,
                h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { editing = null; load(); } }, 'Скасувати'))));
    }

    async function upload(c, file, kind) {
        const problem = kind === 'scan' ? scanProblem(file) : sigProblem(file);
        if (problem) return toast(problem, 'error');
        const orgId = app.context && app.context.org_id;
        const path = contractPath(orgId, c.id, kind, extOf(file.name), uuid());
        const { error } = await app.supabase.storage.from(CONTRACT_BUCKET).upload(path, file, {
            contentType: kind === 'scan' ? scanContentType(file) : 'application/pkcs7-signature', upsert: false,
        });
        if (error) return toast(contractErrorText(error), 'error');
        return path;
    }

    function fileInput(accept, onFile) {
        const input = h('input', { type: 'file', accept, hidden: true });
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.value = '';
            if (file) await onFile(file);
        });
        return input;
    }

    function scanControl(c) {
        const input = fileInput('.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png', async (file) => {
            const path = await upload(c, file, 'scan');
            if (!path) return;
            const out = await callKpApi(app, '/api/contracts/sign', { contract_id: c.id, method: 'scan', path, name: file.name });
            if (!out.ok) return toast(out.error || 'Не вдалося прийняти скан', 'error');
            toast('Скан завантажено');
            load();
        });
        return [h('button', { type: 'button', class: 'btn', onclick: () => input.click() }, c.file_path ? 'Замінити скан' : 'Завантажити скан'), input];
    }

    async function stampSign(c, button) {
        button.disabled = true;
        const out = await callKpApi(app, '/api/contracts/sign', { contract_id: c.id, method: 'image' });
        button.disabled = false;
        if (!out.ok) return toast(out.error || 'Не вдалося підписати', 'error');
        toast('Договір підписано (підпис і печатка)');
        load();
    }

    function kepPanel(c) {
        const panel = h('div', { class: 'card kpk-kep', hidden: true });
        const status = h('div', { 'aria-live': 'polite' });
        const sigInput = fileInput('.p7s', async (file) => {
            const path = await upload(c, file, 'sig');
            if (!path) return;
            clear(status, h('p', { class: 'muted' }, 'Перевіряємо підпис…'));
            const out = await callKpApi(app, '/api/contracts/sign', { contract_id: c.id, method: 'kep', sig_path: path });
            if (!out.ok) return clear(status, notice(out.error || 'Не вдалося прийняти підпис.'));
            toast('КЕП додано');
            load();
        });
        panel.append(
            h('h3', null, 'Підписати КЕП'),
            h('ol', { class: 'small' },
                h('li', null, 'Збережіть скан договору на комп’ютер (кнопка «Відкрити скан»).'),
                h('li', null, 'Відкрийте ', h('a', { href: (kep && kep.sign_url) || 'https://id.gov.ua/sign', target: '_blank', rel: 'noopener noreferrer' }, 'id.gov.ua/sign'),
                    ': ключ — файловий, токен, хмарний або Дія.Підпис. Підпис обирайте окремим файлом (.p7s, CAdES).'),
                h('li', null, 'Завантажте отриманий .p7s сюди.')),
            h('div', { class: 'actions' },
                h('button', { type: 'button', class: 'btn btn-primary', onclick: () => sigInput.click() }, 'Завантажити .p7s'),
                kepWidgetReady(kep) ? h('button', {
                    type: 'button', class: 'btn',
                    onclick: async () => { try { await openKepWidget(kep); } catch (error) { clear(status, notice(error.message)); } },
                }, 'Підписати у віджеті') : null,
                sigInput),
            status);
        return panel;
    }

    function row(c) {
        const locked = c.status !== 'draft';
        const sign = h('button', { type: 'button', class: 'btn' }, 'Підписати печаткою');
        sign.onclick = () => stampSign(c, sign);
        const kepBox = kepPanel(c);
        const mail = writable && c.file_path
            ? emailControl(app, { contract: { id: c.id, label: contractLabel(c), files: attachmentNames(c) }, to: client.email || '', clientName: client.name, orgName: (app.context && app.context.org_name) || '', onSent: load, label: 'Надіслати контрагенту' })
            : null;
        const links = [
            c.file_path ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => signedUrl(c.file_path) }, 'Відкрити скан') : null,
            c.signed_path ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => signedUrl(c.signed_path) }, 'Підписана копія') : null,
            c.sig_path ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => signedUrl(c.sig_path) }, 'Підпис .p7s') : null,
        ];
        return h('div', { class: 'card kpk-row' },
            h('div', { class: 'kpk-head' },
                h('b', null, contractLabel(c)), ' ', h('span', { class: 'tag' }, CONTRACT_STATUS[c.status] || c.status),
                c.sign_method ? h('span', { class: 'muted small' }, ' · ' + (c.sign_method === 'kep' ? 'КЕП' : 'підпис і печатка') + (c.signed_at ? ' ' + fmtDate(c.signed_at) : '')) : null),
            h('p', { class: 'small muted' }, [c.subject, c.valid_until ? 'діє до ' + fmtDate(c.valid_until) : null, c.file_name].filter(Boolean).join(' · ') || '—'),
            h('div', { class: 'actions' }, links,
                writable && !locked ? scanControl(c) : null,
                writable && !locked ? h('button', { type: 'button', class: 'btn', onclick: () => { editing = c; draw(lastRows); } }, 'Змінити') : null,
                writable && !locked && c.file_path ? sign : null,
                writable && !locked && c.file_path ? h('button', { type: 'button', class: 'btn', onclick: () => { kepBox.hidden = !kepBox.hidden; } }, 'Підписати КЕП') : null,
                mail ? mail.button : null),
            writable && !locked && c.file_path ? kepBox : null,
            mail ? mail.panel : null);
    }

    let lastRows = [];
    function draw(rows) {
        lastRows = rows;
        clear(box, h('h2', { class: 'section-title' }, 'Договори'),
            writable ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => { editing = {}; draw(lastRows); } }, 'Додати договір')) : null,
            editing ? form(editing.id ? editing : null) : null,
            rows.length ? rows.map(row) : h('p', { class: 'muted' }, 'Договорів ще немає.' + (writable ? ' Додайте договір і завантажте його скан.' : '')));
    }

    callKpApi(app, '/api/contracts/sign', null, 'GET').then((out) => { if (out.ok) kep = out.kep; });
    load();
    return box;
}
