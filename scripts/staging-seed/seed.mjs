// Засів STAGING-бази: демо-організація, тестові користувачі по ролях, «Власний парк» увімкнений для демо-організації. Жодних продових даних.
// Логіка без мережі й без читання env (усе передається аргументами) — її перевіряє tests/staging-seed.test.mjs з підробленим клієнтом.
// Паролі, ключі й токени ніде не друкуються й не потрапляють у помилки.

// ref продового проєкту Supabase: засів проти нього заборонено.
export const PROD_REF = 'qkfqjorzsxcajcneohoy';
export const DEMO_ORG_NAME = 'Demo Agro (staging)';
export const CONFIRM_VALUE = 'yes';

// role: ключ у БД; label — як підписано в інтерфейсі.
export const SEED_USERS = [
    { key: 'owner', role: 'owner', label: 'Директор' },
    { key: 'director', role: 'director', label: 'Менеджер' },
    { key: 'logist', role: 'logist', label: 'Логіст' },
    { key: 'repair', role: 'repair_manager', label: 'Відповідальний за ремонти' },
    { key: 'requester', role: 'requester', label: 'Замовник підрозділу' },
];

export class SeedError extends Error {}

export function projectRef(url) {
    try {
        return new URL(String(url)).hostname.split('.')[0];
    } catch {
        return '';
    }
}

// Захист: тільки явно підтверджений засів і ніколи не прод (за ref і за середовищем Vercel).
export function assertStaging(env) {
    const url = String((env && env.SUPABASE_URL) || '').trim();
    if (!url || !projectRef(url)) throw new SeedError('SUPABASE_URL (staging) is not set');
    if (projectRef(url) === PROD_REF) throw new SeedError('Refusing to seed: SUPABASE_URL points to the PRODUCTION project');
    if (String(env.VERCEL_ENV || '').toLowerCase() === 'production') throw new SeedError('Refusing to seed: VERCEL_ENV=production');
    if (!String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) throw new SeedError('SUPABASE_SERVICE_ROLE_KEY (staging) is not set');
    if (String(env.STAGING_SEED_CONFIRM || '') !== CONFIRM_VALUE) throw new SeedError('Set STAGING_SEED_CONFIRM=yes to confirm that this is the STAGING project');
    const password = String(env.STAGING_SEED_PASSWORD || '');
    if (password.length < 12) throw new SeedError('STAGING_SEED_PASSWORD must be set (at least 12 characters)');
    return { url, password, domain: String(env.STAGING_SEED_DOMAIN || 'staging.example.com').trim() };
}

export const emailFor = (key, domain) => key + '@' + domain;

const must = (res, what) => {
    if (res && res.error) {
        const err = new SeedError(what + ': ' + String(res.error.code || res.error.message || 'error').slice(0, 80));
        err.code = res.error.code;
        throw err;
    }
    return res ? res.data : null;
};

async function findUserId(client, email) {
    for (let page = 1; page <= 20; page += 1) {
        const data = must(await client.auth.admin.listUsers({ page, perPage: 200 }), 'listUsers');
        const hit = ((data && data.users) || []).find((u) => String(u.email || '').toLowerCase() === email);
        if (hit) return hit.id;
        if (!data || !data.users || data.users.length < 200) return null;
    }
    return null;
}

async function ensureUser(client, { email, password, company }) {
    const existing = await findUserId(client, email);
    if (existing) return { id: existing, created: false };
    const data = must(await client.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: company ? { company_name: company } : {},
    }), 'createUser');
    return { id: data.user.id, created: true };
}

async function profileOrg(client, userId) {
    const row = must(await client.from('profiles').select('org_id').eq('id', userId).maybeSingle(), 'profiles');
    if (!row || !row.org_id) throw new SeedError('profile of the owner was not created by the signup trigger');
    return row.org_id;
}

// «Власний парк» (потребує міграцій модуля): відсутні таблиці — не помилка, лише нотатка в журналі.
async function seedOwnFleet(client, orgId, ids, log) {
    try {
        const units = [];
        for (const name of ['Агро Північ', 'Елеватор Центральний']) {
            const found = must(await client.from('org_units').select('id').eq('org_id', orgId).eq('name', name).maybeSingle(), 'org_units');
            if (found) { units.push(found.id); continue; }
            must(await client.from('org_units').insert({ org_id: orgId, name, kind: name.startsWith('Елеватор') ? 'elevator' : 'agro' }), 'org_units');
            units.push(must(await client.from('org_units').select('id').eq('org_id', orgId).eq('name', name).maybeSingle(), 'org_units').id);
        }
        for (const [name, kind, unit] of [['Поле 1 (Північ)', 'field', units[0]], ['Склад елеватора', 'warehouse', units[1]], ['Спільний елеватор', 'elevator', null]]) {
            const found = must(await client.from('org_points').select('id').eq('org_id', orgId).eq('name', name).maybeSingle(), 'org_points');
            if (!found) must(await client.from('org_points').insert({ org_id: orgId, name, kind, unit_id: unit }), 'org_points');
        }
        must(await client.from('org_requesters').upsert({ org_id: orgId, user_id: ids.requester }, { onConflict: 'org_id,user_id', ignoreDuplicates: true }), 'org_requesters');
        must(await client.from('org_unit_members').upsert({ unit_id: units[0], user_id: ids.requester, org_id: orgId }, { onConflict: 'unit_id,user_id', ignoreDuplicates: true }), 'org_unit_members');
        log('own_fleet: 2 units, 3 points, requester attached to the first unit');
    } catch (error) {
        if (error && /^(42P01|PGRST205|PGRST202)$/.test(String(error.code))) log('own_fleet: tables are missing — apply the own_fleet migrations first, then re-run (skipped)');
        else throw error;
    }
}

// Ідемпотентний засів. client — supabase-js із service_role STAGING-проєкту; log — функція (без секретів).
export async function runSeed({ client, env, log = () => {} }) {
    const { password, domain } = assertStaging(env);
    const ids = {};
    for (const user of SEED_USERS) {
        const email = emailFor(user.key, domain);
        const made = await ensureUser(client, { email, password, company: user.key === 'owner' ? DEMO_ORG_NAME : null });
        ids[user.key] = made.id;
        log((made.created ? 'created  ' : 'existing ') + user.label.padEnd(26) + email);
    }
    const orgId = await profileOrg(client, ids.owner);
    must(await client.from('organizations').update({ name: DEMO_ORG_NAME }).eq('id', orgId), 'organizations');
    must(await client.rpc('set_org_plan', { p_org: orgId, p_plan: 'control_plus' }), 'set_org_plan');
    // Логіст — активний учасник демо-організації (як після прийнятого запрошення).
    must(await client.from('profiles').update({ org_id: orgId, org_role: 'logist', member_status: 'active', is_approved: true }).eq('id', ids.logist), 'profiles');
    // Менеджер (director) — окрема таблиця; відповідальний за ремонти — через org_repair_handlers.
    must(await client.from('org_directors').upsert({ org_id: orgId, user_id: ids.director }, { onConflict: 'org_id,user_id', ignoreDuplicates: true }), 'org_directors');
    must(await client.from('org_repair_handlers').upsert({ org_id: orgId, user_id: ids.repair, kind: 'repair_manager' }, { onConflict: 'org_id,user_id', ignoreDuplicates: true }), 'org_repair_handlers');
    // «Власний парк»: прапорець організації + глобальний вимикач (app_settings); обидва потрібні (feature_enabled AND прапорець).
    must(await client.from('organizations').update({ features: { own_fleet: true } }).eq('id', orgId), 'organizations');
    try {
        must(await client.from('app_settings').upsert({ key: 'own_fleet', enabled: true }, { onConflict: 'key' }), 'app_settings');
        log('app_settings: own_fleet = enabled');
    } catch (error) {
        if (error && /^(42P01|PGRST205)$/.test(String(error.code))) log('app_settings: table is missing — apply the kill-switch migration first, then re-run (skipped)');
        else throw error;
    }
    await seedOwnFleet(client, orgId, ids, log);
    return { orgId, users: SEED_USERS.map((u) => ({ role: u.role, label: u.label, email: emailFor(u.key, domain) })) };
}
