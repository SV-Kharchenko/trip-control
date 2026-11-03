// POST /api/kp-lead — заявка «Замовити демо» з /kontrol-plus. Публічний ендпоінт: ліміт за IP, поле-пастка, запис лише через service role.
import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit, clientIp } from '../lib/rate-limit.js';
import { processLead, LEAD_RATE_PER_MINUTE, LEAD_MAX_BODY_BYTES } from '../lib/kp-lead.js';
import { LEAD_TO } from '../lib/kp-lead-mail.js';
import { sendInviteEmail } from '../lib/invite-mail.js';

// Розмір тіла: за Content-Length, а для вже розібраного тіла — за довжиною серіалізації.
function bodyTooLarge(req) {
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > LEAD_MAX_BODY_BYTES) return true;
    const body = req.body;
    if (typeof body === 'string') return Buffer.byteLength(body) > LEAD_MAX_BODY_BYTES;
    if (Buffer.isBuffer(body)) return body.length > LEAD_MAX_BODY_BYTES;
    if (body && typeof body === 'object') {
        try { return Buffer.byteLength(JSON.stringify(body)) > LEAD_MAX_BODY_BYTES; } catch { return true; }
    }
    return false;
}

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
        if (bodyTooLarge(req)) return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
        // Лише за IP (токен ігноруємо): публічна форма, ліміт 5 заявок на хвилину.
        const guard = { env, rpc: deps.rpc, getUser: async () => null, anon: LEAD_RATE_PER_MINUTE };
        if (!(await enforceRateLimit(req, res, 'kp-lead', guard))) return undefined;
        const body = parseBody(req);
        if (!body || typeof body !== 'object') return res.status(400).json({ code: 'VALIDATION', error: 'Некоректний запит.' });
        const result = await processLead(body, clientIp(req), {
            ipSalt: env.KP_LEAD_IP_SALT,
            insert: deps.insert || defaultInsert(env),
            sendMail: deps.sendMail || ((message) => sendInviteEmail(LEAD_TO, message, { env, fetch: deps.fetch || globalThis.fetch }))
        });
        return res.status(result.status).json(result.body);
    };
}

export default createKpLeadHandler();
