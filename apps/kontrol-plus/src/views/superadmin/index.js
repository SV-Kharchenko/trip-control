// Кабінет суперадміна платформи (#/superadmin), lazy-чанк: глобальні функції (app_settings), компанії (organizations.features), журнал.
// Усі дані й зміни — через sa_* RPC (SECURITY DEFINER, перша перевірка is_platform_superadmin()); фронт лише ховає сторінку від решти.
import '../../kp-superadmin.css';
import { h, clear, notice, spinner, toast } from '../../ui.js';
import {
    AGRO_CHOICES, AUDIT_PAGE, MODULES, ORGS_PAGE, PLANS, PLAN_MODULES_HINT, actionLabel, agroChoiceArg, agroChoiceValue, agroEffectiveText, auditTarget, auditValue, formatWhen, featureOn, moduleInfo, orgModuleNote, planConfirm, planLabel, settingRows, superadminErrorText,
} from '../../lib/superadmin.js';

// Підтвердження — діалог сайту (tcModal); без нього дію НЕ виконуємо.
function confirmDialog(options) {
    return typeof window !== 'undefined' && typeof window.tcModal === 'function' ? window.tcModal(options) : Promise.resolve({ ok: false });
}

const STATE_TEXT = { on: 'Увімкнено', off: 'Вимкнено', missing: 'Рядка немає — функція вимкнена' };

function pager(offset, total, size, onPage) {
    const from = total ? offset + 1 : 0;
    const to = Math.min(offset + size, total);
    return h('div', { class: 'kpsa-pager' },
        h('button', { type: 'button', class: 'btn', 'data-act': 'prev', disabled: offset <= 0, onclick: () => onPage(Math.max(0, offset - size)) }, '← Назад'),
        h('span', { class: 'muted small' }, from + '–' + to + ' з ' + total),
        h('button', { type: 'button', class: 'btn', 'data-act': 'next', disabled: offset + size >= total, onclick: () => onPage(offset + size) }, 'Далі →'));
}

export function renderSuperadmin(app) {
    const rpc = (name, args) => app.supabase.rpc(name, args);
    let settings = [];
    const globalBox = h('div', { class: 'kpsa-box', id: 'kpsa-global' }, spinner());
    const orgsBox = h('div', { class: 'kpsa-box', id: 'kpsa-orgs' }, spinner());
    const auditBox = h('div', { class: 'kpsa-box', id: 'kpsa-audit' }, spinner());
    const q = h('input', { type: 'search', placeholder: 'Назва або ЄДРПОУ', 'aria-label': 'Пошук компанії', maxlength: 80 });
    let orgOffset = 0;
    let auditOffset = 0;

    const globalState = (key) => (settingRows(settings).find((r) => r.key === key) || {}).state || 'missing';

    // ---------- Глобальні функції ----------
    async function setGlobal(row, enabled) {
        const info = moduleInfo(row.key);
        const answer = await confirmDialog({
            title: (enabled ? 'Увімкнути' : 'Вимкнути') + ' «' + info.label + '» для всієї платформи?',
            text: enabled ? 'Модуль запрацює в компаніях, де для нього ввімкнено прапорець.' : 'Модуль одразу зникне в усіх компаніях; дані не видаляються.',
            confirmText: enabled ? 'Увімкнути' : 'Вимкнути',
            danger: !enabled,
        });
        if (!answer || !answer.ok) return;
        const { error } = await rpc('sa_set_setting', { p_key: row.key, p_enabled: enabled });
        if (error) { toast(superadminErrorText(error), 'error'); return; }
        toast('Збережено', 'ok');
        await loadAll();
    }
    async function createGlobal(row) {
        const info = moduleInfo(row.key);
        const answer = await confirmDialog({
            title: 'Створити рядок перемикача «' + info.label + '»?',
            text: 'Рядок буде створено у вимкненому стані: поведінка не зміниться, але модуль можна буде вмикати перемикачем.',
            confirmText: 'Створити',
        });
        if (!answer || !answer.ok) return;
        const { error } = await rpc('sa_create_setting', { p_key: row.key, p_enabled: false });
        if (error) { toast(superadminErrorText(error), 'error'); return; }
        toast('Рядок створено', 'ok');
        await loadAll();
    }
    function renderGlobal() {
        const rows = settingRows(settings);
        clear(globalBox, h('div', { class: 'kpsa-list', role: 'list' }, rows.map((r) => h('div', { class: 'kpsa-row kpsa-global', role: 'listitem', 'data-key': r.key },
            h('div', { class: 'kpsa-main' }, h('b', null, r.label), h('div', { class: 'muted small' }, r.desc), h('code', { class: 'kpsa-key' }, r.key)),
            h('span', { class: 'kpsa-state kpsa-state-' + r.state, 'data-state': r.state }, STATE_TEXT[r.state]),
            h('div', { class: 'kpsa-acts' }, r.state === 'missing'
                ? h('button', { type: 'button', class: 'btn', 'data-act': 'create', onclick: () => createGlobal(r) }, 'Створити рядок')
                : h('button', { type: 'button', class: 'btn ' + (r.state === 'on' ? 'btn-danger' : ''), 'data-act': 'toggle', onclick: () => setGlobal(r, r.state !== 'on') },
                    r.state === 'on' ? 'Вимкнути' : 'Увімкнути'))))));
    }

    // ---------- Організації ----------
    async function setOrgFeature(org, key, enabled) {
        const info = moduleInfo(key);
        const answer = await confirmDialog({
            title: (enabled ? 'Увімкнути' : 'Вимкнути') + ' «' + info.label + '» для «' + (org.name || 'компанії') + '»?',
            text: enabled ? 'Модуль запрацює в цій компанії, якщо його ввімкнено глобально.' : 'Модуль зникне в цій компанії; дані не видаляються.',
            confirmText: enabled ? 'Увімкнути' : 'Вимкнути',
            danger: !enabled,
        });
        if (!answer || !answer.ok) return;
        const { error } = await rpc('sa_set_org_feature', { p_org: org.id, p_key: key, p_enabled: enabled });
        if (error) { toast(superadminErrorText(error), 'error'); return; }
        toast('Збережено', 'ok');
        await Promise.all([loadOrgs(), loadAudit()]);
    }
    // Тариф: «Сайт» / «Контроль+». Лише підтвердження + sa_set_org_plan; оплата не чіпається.
    async function setOrgPlan(org, plan) {
        if (org.plan === plan) return;
        const confirm = planConfirm(org.name, plan);
        const answer = await confirmDialog({ title: confirm.title, text: confirm.text, confirmText: plan === 'control_plus' ? 'Увімкнути' : 'Перевести', danger: plan === 'company' });
        if (!answer || !answer.ok) return;
        const { error } = await rpc('sa_set_org_plan', { p_org: org.id, p_plan: plan });
        if (error) { toast(superadminErrorText(error), 'error'); return; }
        org.plan = plan;
        toast('Тариф змінено: ' + planLabel(plan), 'ok');
        await Promise.all([loadOrgs(), loadAudit()]);
    }
    function planBadge(plan) {
        return h('span', { class: 'kpsa-plan-badge kpsa-plan-' + (plan === 'control_plus' ? 'cp' : 'site'), 'data-plan': plan || '' }, planLabel(plan));
    }
    function planBlock(org) {
        return h('div', { class: 'kpsa-plan' },
            h('span', { class: 'kpsa-plan-title' }, 'Тариф'),
            h('div', { class: 'kpsa-seg', role: 'group', 'aria-label': 'Тариф компанії ' + (org.name || '') },
                PLANS.map((p) => h('button', { type: 'button', class: 'kpsa-seg-btn' + (org.plan === p.key ? ' is-active' : ''), 'data-plan': p.key, 'aria-pressed': String(org.plan === p.key),
                    onclick: () => setOrgPlan(org, p.key) }, p.label))),
            h('div', { class: 'muted small kpsa-plan-hint' }, PLAN_MODULES_HINT));
    }
    // Блок «Доступ до AGRO для користувачів»: вантажиться, лише коли його розгорнули; зміна — через sa_set_user_agro із підтвердженням.
    function agroUsersBlock(org) {
        const body = h('div', { class: 'kpsa-agro-list', role: 'list' });
        let loaded = false;
        async function load() {
            clear(body, spinner());
            const { data, error } = await rpc('sa_list_org_agro_users', { p_org: org.id });
            if (error) { clear(body, notice(superadminErrorText(error))); loaded = false; return; }
            const rows = data || [];
            clear(body, rows.length ? rows.map(userRow) : h('p', { class: 'muted small' }, 'У компанії немає активних користувачів.'));
        }
        async function setUser(row, select) {
            const value = select.value;
            const allowed = agroChoiceArg(value);
            const label = AGRO_CHOICES.find((c) => c[0] === value)[1];
            const answer = await confirmDialog({
                title: 'Доступ до Park-Control для ' + (row.email || 'користувача') + ': «' + label + '»?',
                text: allowed === null ? 'Доступ знову визначатиме компанія.' : allowed ? 'Користувач зможе входити в Park-Control, навіть якщо компанії доступ не відкрито (за умови глобального вмикання).' : 'Користувач не зможе входити в Park-Control, навіть якщо компанії доступ відкрито.',
                confirmText: 'Зберегти',
                danger: allowed === false,
            });
            if (!answer || !answer.ok) { select.value = agroChoiceValue(row.override); return; }
            select.disabled = true;
            const { error } = await rpc('sa_set_user_agro', { p_user: row.user_id, p_allowed: allowed });
            if (error) { select.disabled = false; select.value = agroChoiceValue(row.override); toast(superadminErrorText(error), 'error'); return; }
            toast('Збережено', 'ok');
            await Promise.all([load(), loadAudit()]);
        }
        function userRow(row) {
            const select = h('select', { class: 'kpsa-agro-select', 'aria-label': 'Доступ до Park-Control: ' + (row.email || ''), onchange: () => setUser(row, select) },
                AGRO_CHOICES.map(([value, text]) => h('option', { value }, text)));
            select.value = agroChoiceValue(row.override);
            return h('div', { class: 'kpsa-agro-row', role: 'listitem', 'data-user': row.user_id },
                h('div', { class: 'kpsa-main' }, h('b', null, row.email || '—'), h('div', { class: 'muted small' }, row.org_role || '')),
                select,
                h('div', { class: 'kpsa-agro-eff ' + (row.allowed === true ? 'is-on' : 'is-off'), 'data-allowed': String(row.allowed === true) }, agroEffectiveText(row)));
        }
        return h('details', { class: 'kpsa-agro', ontoggle: (e) => { if (e.target.open && !loaded) { loaded = true; load(); } } },
            h('summary', null, 'Доступ до Park-Control для користувачів'), body);
    }
    function orgRow(org) {
        const modules = MODULES.map((m) => {
            const on = featureOn(org.features, m.key);
            const note = orgModuleNote(on, globalState(m.key));
            return h('div', { class: 'kpsa-mod', 'data-key': m.key },
                h('label', { class: 'kpsa-switch' },
                    h('input', { type: 'checkbox', checked: on, 'aria-label': m.label + ': ' + (org.name || ''), onclick: (e) => { e.preventDefault(); setOrgFeature(org, m.key, !on); } }),
                    h('span', null, m.label)),
                note ? h('div', { class: 'kpsa-hint ' + (on ? 'kpsa-warn' : 'muted small') }, note) : null);
        });
        return h('div', { class: 'kpsa-row kpsa-org', role: 'listitem', 'data-org': org.id },
            h('div', { class: 'kpsa-main' }, h('b', null, org.name || 'Без назви'), planBadge(org.plan), h('div', { class: 'muted small' }, org.edrpou ? 'ЄДРПОУ ' + org.edrpou : 'ЄДРПОУ не вказано')),
            h('div', { class: 'kpsa-cell', 'data-label': 'Тип' }, org.legal_form || '—'),
            h('div', { class: 'kpsa-cell', 'data-label': 'Користувачів' }, String(org.members ?? 0)),
            planBlock(org),
            h('div', { class: 'kpsa-mods', 'data-label': 'Модулі' }, modules),
            agroUsersBlock(org));
    }
    async function loadOrgs() {
        const { data, error } = await rpc('sa_search_orgs', { p_q: q.value.trim(), p_limit: ORGS_PAGE, p_offset: orgOffset });
        if (error) { clear(orgsBox, notice(superadminErrorText(error))); return; }
        const rows = data || [];
        const total = rows.length ? Number(rows[0].total) : 0;
        clear(orgsBox,
            rows.length ? h('div', { class: 'kpsa-head kpsa-org-head', 'aria-hidden': 'true' }, h('span', null, 'Компанія'), h('span', null, 'Тип'), h('span', null, 'Користувачів'), h('span', null, 'Модулі')) : null,
            h('div', { class: 'kpsa-list', role: 'list' }, rows.length ? rows.map(orgRow) : h('p', { class: 'muted' }, 'Нічого не знайдено.')),
            total > ORGS_PAGE ? pager(orgOffset, total, ORGS_PAGE, (o) => { orgOffset = o; loadOrgs(); }) : null);
    }

    // ---------- Аудит ----------
    async function loadAudit() {
        const { data, error } = await rpc('sa_list_audit', { p_from: null, p_to: null, p_target_type: null, p_limit: AUDIT_PAGE, p_offset: auditOffset });
        if (error) { clear(auditBox, notice(superadminErrorText(error))); return; }
        const rows = data || [];
        const total = rows.length ? Number(rows[0].total) : 0;
        clear(auditBox,
            rows.length ? h('div', { class: 'kpsa-list', role: 'list' }, rows.map((r) => h('div', { class: 'kpsa-row kpsa-audit', role: 'listitem' },
                h('div', { class: 'kpsa-cell', 'data-label': 'Коли' }, formatWhen(r.at)),
                h('div', { class: 'kpsa-cell', 'data-label': 'Хто' }, r.admin_email || String(r.admin_id || '').slice(0, 8)),
                h('div', { class: 'kpsa-main' }, h('b', null, actionLabel(r.action)), h('div', { class: 'muted small' }, auditTarget(r))),
                h('div', { class: 'kpsa-cell', 'data-label': 'Було → стало' }, auditValue(r.before) + ' → ' + auditValue(r.after))))) : h('p', { class: 'muted' }, 'Змін ще не було.'),
            total > AUDIT_PAGE ? pager(auditOffset, total, AUDIT_PAGE, (o) => { auditOffset = o; loadAudit(); }) : null);
    }

    async function loadSettings() {
        const { data, error } = await rpc('sa_list_settings');
        if (error) { clear(globalBox, notice(superadminErrorText(error))); return false; }
        settings = data || [];
        renderGlobal();
        return true;
    }
    async function loadAll() {
        if (await loadSettings()) await Promise.all([loadOrgs(), loadAudit()]);
    }

    const search = h('form', { class: 'kpsa-search', onsubmit: (e) => { e.preventDefault(); orgOffset = 0; loadOrgs(); } }, q, h('button', { class: 'btn', type: 'submit' }, 'Знайти'));
    loadAll();
    return h('section', { class: 'page kpsa' },
        h('h1', { class: 'kpsa-h1' }, 'Платформа'),
        h('p', { class: 'muted' }, 'Лише для адміністраторів платформи. Кожна зміна записується в журнал.'),
        h('h2', { class: 'kpsa-h2' }, 'Глобальні функції'), globalBox,
        h('h2', { class: 'kpsa-h2' }, 'Організації'), search, orgsBox,
        h('h2', { class: 'kpsa-h2' }, 'Аудит'), auditBox);
}
