import { createClient } from '@supabase/supabase-js';
import {
    buildWeeklyReport,
    previousWeekRange,
    reportRecipient,
    normalizeAlertPct,
    cronAuthorized,
    deliverReport,
    mailProvider
} from '../lib/weekly-report.js';

/**
 * Weekly report from saved calculations and trip_actuals. The calculator is not called.
 *
 * GET  /api/weekly-report
 *   Authorization: Bearer <user jwt>     — owner preview, no send
 *   Authorization: Bearer <CRON_SECRET>  — Monday job (Vercel cron). Empty weeks are skipped.
 * POST /api/weekly-report
 *   { "action": "preview" | "send" } with the owner jwt
 *   Cron may also POST. A send is idempotent per org and week.
 *
 * Mail fails closed until RESEND_API_KEY and REPORT_FROM_EMAIL are set.
 * Cron stays closed until CRON_SECRET is set. None of these belong in the client.
 */
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAIL_MISSING = 'Лист не надіслано. На сервері потрібні RESEND_API_KEY і REPORT_FROM_EMAIL.';

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function bearer(req) {
    const header = req.headers.authorization || req.headers.Authorization || '';
    return String(header);
}

async function requireOwner(req) {
    const header = bearer(req);
    if (!header.startsWith('Bearer ')) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Необхідна авторизація.');
    }
    const token = header.slice('Bearer '.length);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) throw new HttpError(401, 'BAD_TOKEN', 'Недійсний токен.');
    const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, org_id, org_role, member_status, organizations(status)')
        .eq('id', user.id)
        .single();
    if (profileError || !profile || !profile.org_id) {
        throw new HttpError(403, 'NO_PROFILE', 'Профіль користувача не знайдено.');
    }
    if (profile.member_status !== 'active') {
        throw new HttpError(403, 'MEMBER_DISABLED', 'Доступ до компанії відключено.');
    }
    if (!profile.organizations || profile.organizations.status === 'blocked') {
        throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
    }
    if (profile.org_role !== 'owner') {
        throw new HttpError(403, 'REPORT_FORBIDDEN', 'Тижневий звіт доступний власнику.');
    }
    return profile;
}

async function loadTrips(orgId, period) {
    const { data, error } = await supabase
        .from('calculations')
        .select('id, name, trip_date, route_from, route_to, client_name, status, revenue, profit')
        .eq('org_id', orgId)
        .gte('trip_date', period.start)
        .lte('trip_date', period.end)
        .limit(1000);
    if (error) throw error;
    const rows = data || [];
    const actualById = new Map();
    for (let i = 0; i < rows.length; i += 100) {
        const ids = rows.slice(i, i + 100).map((row) => row.id);
        if (!ids.length) continue;
        const { data: facts, error: factError } = await supabase
            .from('trip_actuals')
            .select('calculation_id, profit')
            .in('calculation_id', ids);
        if (factError) throw factError;
        (facts || []).forEach((fact) => actualById.set(fact.calculation_id, fact.profit));
    }
    return rows.map((row) => ({
        tripDate: row.trip_date,
        routeFrom: row.route_from,
        routeTo: row.route_to,
        name: row.name,
        clientName: row.client_name,
        status: row.status,
        revenue: row.revenue,
        profit: row.profit,
        actualProfit: actualById.has(row.id) ? actualById.get(row.id) : null
    }));
}

async function compose(orgId, now) {
    const [orgRes, profileRes, ownerRes, settingsRes] = await Promise.all([
        supabase.from('organizations').select('id, name, status').eq('id', orgId).single(),
        supabase.from('org_company_profiles').select('report_email').eq('org_id', orgId).maybeSingle(),
        supabase.from('profiles')
            .select('email')
            .eq('org_id', orgId)
            .eq('org_role', 'owner')
            .eq('member_status', 'active')
            .order('created_at', { ascending: true })
            .limit(1),
        supabase.from('company_settings').select('settings').eq('org_id', orgId).maybeSingle()
    ]);
    if (orgRes.error || !orgRes.data) throw new HttpError(404, 'NO_ORG', 'Компанію не знайдено.');
    if (profileRes.error) throw profileRes.error;
    if (ownerRes.error) throw ownerRes.error;
    if (settingsRes.error) throw settingsRes.error;
    if (orgRes.data.status === 'blocked') {
        throw new HttpError(403, 'ORG_BLOCKED', 'Доступ компанії заблоковано.');
    }
    const period = previousWeekRange(now || new Date());
    const trips = await loadTrips(orgId, period);
    const settings = settingsRes.data && settingsRes.data.settings;
    const report = buildWeeklyReport({
        orgName: orgRes.data.name,
        periodStart: period.start,
        periodEnd: period.end,
        trips,
        alertPct: normalizeAlertPct(settings && settings.fact_alert_pct)
    });
    const owner = (ownerRes.data || [])[0];
    return {
        report,
        recipient: reportRecipient(profileRes.data && profileRes.data.report_email, owner && owner.email),
        period
    };
}

async function existingStatus(orgId, periodStart) {
    const { data, error } = await supabase
        .from('weekly_reports')
        .select('status')
        .eq('org_id', orgId)
        .eq('period_start', periodStart)
        .maybeSingle();
    if (error) throw error;
    return data ? data.status : '';
}

async function remember(orgId, composed, status, errorText) {
    const summary = composed.report.summary;
    const { error } = await supabase.from('weekly_reports').upsert({
        org_id: orgId,
        period_start: composed.period.start,
        period_end: composed.period.end,
        recipient: composed.recipient || null,
        subject: composed.report.subject,
        status,
        error: errorText || null,
        trip_count: summary.tripCount,
        planned_profit: summary.plannedProfit,
        actual_profit: summary.factCount ? summary.actualProfit : null,
        alert_count: summary.alertCount,
        updated_at: new Date().toISOString()
    }, { onConflict: 'org_id,period_start' });
    if (error) throw error;
}

function publicBody(result) {
    const messages = {
        REPORT_MAIL_UNCONFIGURED: MAIL_MISSING,
        NO_RECIPIENT: 'Немає пошти для звіту. Заповни «Пошта для звітів» або пошту реєстрації.',
        REPORT_MAIL_FAILED: 'Пошта не прийняла лист.',
        ORG_BLOCKED: 'Доступ компанії заблоковано.'
    };
    return {
        ok: !!result.ok,
        code: result.code || undefined,
        sent: !!result.sent,
        alreadySent: !!result.alreadySent,
        skipped: !!result.skipped,
        recipient: result.recipient || '',
        subject: result.report ? result.report.subject : '',
        text: result.report ? result.report.text : '',
        summary: result.report ? result.report.summary : null,
        period: result.report ? result.report.period : null,
        mailConfigured: !!mailProvider(),
        error: result.ok ? undefined : (messages[result.code] || 'Не вдалося надіслати звіт.')
    };
}

async function sendComposed(orgId, composed) {
    if (!composed.recipient) {
        await remember(orgId, composed, 'skipped', 'NO_RECIPIENT');
        return { ok: false, code: 'NO_RECIPIENT', status: 422, report: composed.report };
    }
    if (!mailProvider()) {
        return { ok: false, code: 'REPORT_MAIL_UNCONFIGURED', status: 503, report: composed.report, recipient: composed.recipient };
    }
    const prior = await existingStatus(orgId, composed.period.start);
    if (prior === 'sent') {
        return { ok: true, alreadySent: true, status: 200, report: composed.report, recipient: composed.recipient };
    }
    try {
        await deliverReport({
            to: composed.recipient,
            subject: composed.report.subject,
            text: composed.report.text,
            html: composed.report.html
        }, { fetch, env: process.env });
        await remember(orgId, composed, 'sent', null);
        return { ok: true, sent: true, status: 200, report: composed.report, recipient: composed.recipient };
    } catch (error) {
        const code = error.code || 'REPORT_MAIL_FAILED';
        if (code !== 'REPORT_MAIL_UNCONFIGURED') {
            await remember(orgId, composed, 'failed', code);
        }
        return {
            ok: false,
            code,
            status: code === 'REPORT_MAIL_UNCONFIGURED' ? 503 : 502,
            report: composed.report,
            recipient: composed.recipient
        };
    }
}

async function sendForOrg(orgId, options = {}) {
    const composed = await compose(orgId, options.now);
    if (!options.allowEmpty && composed.report.summary.tripCount === 0) {
        return { ok: true, skipped: true, status: 200, report: composed.report, recipient: composed.recipient };
    }
    return sendComposed(orgId, composed);
}

async function runCron(now) {
    if (!mailProvider()) {
        return { ok: false, code: 'REPORT_MAIL_UNCONFIGURED', status: 503 };
    }
    const { data, error } = await supabase.from('organizations').select('id, status').limit(1000);
    if (error) throw error;
    const counts = { sent: 0, failed: 0, skipped: 0, alreadySent: 0, empty: 0 };
    for (const org of data || []) {
        if (org.status === 'blocked') {
            counts.skipped += 1;
            continue;
        }
        try {
            const result = await sendForOrg(org.id, { allowEmpty: false, now });
            if (result.sent) counts.sent += 1;
            else if (result.alreadySent) counts.alreadySent += 1;
            else if (result.skipped) counts.empty += 1;
            else counts.failed += 1;
        } catch (orgError) {
            console.warn('weekly report org failed', org.id, orgError.code || orgError.message);
            counts.failed += 1;
        }
    }
    return { ok: true, status: 200, counts };
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
        if (cronAuthorized(bearer(req), process.env.CRON_SECRET)) {
            const result = await runCron();
            return res.status(result.status).json({
                ok: result.ok,
                code: result.code,
                error: result.code === 'REPORT_MAIL_UNCONFIGURED' ? MAIL_MISSING : undefined,
                counts: result.counts
            });
        }
        const owner = await requireOwner(req);
        const action = req.method === 'GET' ? 'preview' : String((req.body || {}).action || '');
        if (action === 'preview') {
            const composed = await compose(owner.org_id);
            return res.status(200).json({
                ok: true,
                preview: true,
                recipient: composed.recipient,
                subject: composed.report.subject,
                text: composed.report.text,
                summary: composed.report.summary,
                period: composed.report.period,
                mailConfigured: !!mailProvider()
            });
        }
        if (action === 'send') {
            const result = await sendForOrg(owner.org_id, { allowEmpty: true });
            return res.status(result.status).json(publicBody(result));
        }
        return res.status(400).json({ error: 'Невідома дія.', code: 'BAD_ACTION' });
    } catch (error) {
        const status = error.status || 500;
        if (status >= 500) console.warn('weekly report failed', error.code || error.message);
        return res.status(status).json({
            error: status >= 500 ? 'Не вдалося зібрати звіт.' : (error.message || 'Не вдалося зібрати звіт.'),
            code: error.code || 'REPORT_FAILED'
        });
    }
}
