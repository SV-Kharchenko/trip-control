// POST /api/kp-lead — заявка «Замовити демо» з /kontrol-plus. Публічний ендпоінт: ліміт за IP, поле-пастка, запис лише через service role.
import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit, clientIp } from '../lib/rate-limit.js';
import { processLead, LEAD_RATE_PER_MINUTE } from '../lib/kp-lead.js';
import { LEAD_TO } from '../lib/kp-lead-mail.js';
import { sendInviteEmail } from '../lib/invite-mail.js';

function parseBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    try { return JSON.parse(String(req.body || '')); } catch { return null; }
}

let client = null;
function defaultInsert(env) {
    return async (row) => {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { error: { message: 'no supabase env' } };
        if (!client) client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        return client.from('kp_leads').insert(row);
    };
}

export function createKpLeadHandler(deps = {}) {
    return async function handler(req, res) {
        const env = deps.env || process.env;
        if (req.method !== 'POST') {
            if (typeof res.setHeader === 'function') res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD', error: 'Метод не підтримується.' });
        }
        // Лише за IP (токен ігноруємо): публічна форма, ліміт 5 заявок на хвилину.
        const guard = { env, rpc: deps.rpc, getUser: async () => null, anon: LEAD_RATE_PER_MINUTE };
        if (!(await enforceRateLimit(req, res, 'kp-lead', guard))) return undefined;
        const body = parseBody(req);
        if (!body || typeof body !== 'object') return res.status(400).json({ code: 'VALIDATION', error: 'Некоректний запит.' });
        const result = await processLead(body, clientIp(req), {
            insert: deps.insert || defaultInsert(env),
            sendMail: deps.sendMail || ((message) => sendInviteEmail(LEAD_TO, message, { env, fetch: deps.fetch || globalThis.fetch }))
        });
        return res.status(result.status).json(result.body);
    };
}

export default createKpLeadHandler();
