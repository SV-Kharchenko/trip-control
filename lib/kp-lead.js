// Заявка «Замовити демо» з лендингу /kontrol-plus: валідація, запис у kp_leads (service role) і лист на support@trip-control.com.
import crypto from 'node:crypto';
import { buildLeadEmail } from './kp-lead-mail.js';
import { validEmail } from './weekly-report.js';

export const LEAD_LIMITS = { name: 120, company: 160, phone: 40, email: 160, comment: 2000, vehicles: 100000 };
export const LEAD_RATE_PER_MINUTE = 5;
export const LEAD_TRAP_FIELD = 'website';

const clean = (value, max) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim().slice(0, max);

// → { ok: true, lead } | { ok: false, errors: { поле: повідомлення } }. Поле-пастка перевіряє обробник, не тут.
export function validateLead(body) {
    const src = body && typeof body === 'object' ? body : {};
    const errors = {};
    const name = clean(src.name, LEAD_LIMITS.name).replace(/\s+/g, ' ');
    const company = clean(src.company, LEAD_LIMITS.company).replace(/\s+/g, ' ');
    const phone = clean(src.phone, LEAD_LIMITS.phone);
    const email = clean(src.email, LEAD_LIMITS.email);
    const comment = clean(src.comment, LEAD_LIMITS.comment);
    if (!name) errors.name = 'Вкажіть імʼя.';
    if (!company) errors.company = 'Вкажіть компанію.';
    const digits = phone.replace(/\D/g, '');
    if (!phone || !/^\+?[\d\s()\-.]+$/.test(phone) || digits.length < 9 || digits.length > 15) errors.phone = 'Вкажіть коректний телефон.';
    if (email && (!validEmail(email) || /[\r\n]/.test(email))) errors.email = 'Некоректний email.';
    let vehicles = null;
    const rawVehicles = src.vehicles == null ? '' : String(src.vehicles).trim();
    if (rawVehicles) {
        const n = Number(rawVehicles);
        if (!Number.isInteger(n) || n < 1 || n > LEAD_LIMITS.vehicles) errors.vehicles = 'Кількість машин — ціле число від 1.';
        else vehicles = n;
    }
    if (src.consent !== true && src.consent !== 'true' && src.consent !== 'on') errors.consent = 'Потрібна згода з політикою конфіденційності.';
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, lead: { name, company, phone, email: email || null, vehicles, comment: comment || null } };
}

export const LEAD_MAX_BODY_BYTES = 16 * 1024;

// SHA-256 від секретної солі (env KP_LEAD_IP_SALT) і IP. Без солі → null (без неї хеш IPv4 перебирається за секунди).
export function ipHash(ip, salt) {
    const secret = String(salt || '');
    if (!secret) return null;
    return crypto.createHash('sha256').update(secret + ':' + String(ip || 'unknown')).digest('hex');
}

let saltWarned = false;
function warnNoSaltOnce() {
    if (saltWarned) return;
    saltWarned = true;
    console.warn('kp-lead: KP_LEAD_IP_SALT is not set, ip_hash is stored as null');
}
export function resetSaltWarning() { saltWarned = false; }

// deps: { insert(row) → { error }, sendMail(message) → Promise, now }. Запис у базу обов'язковий; збій листа заявку не губить.
export async function processLead(body, ip, deps) {
    if (body && typeof body === 'object' && clean(body[LEAD_TRAP_FIELD], 200)) return { status: 200, body: { ok: true } };
    const checked = validateLead(body);
    if (!checked.ok) return { status: 400, body: { code: 'VALIDATION', error: 'Перевірте поля форми.', errors: checked.errors } };
    const row = { ...checked.lead, status: 'new', ip_hash: ipHash(ip, deps.ipSalt) };
    if (row.ip_hash === null) warnNoSaltOnce();
    const { error } = await deps.insert(row);
    if (error) return { status: 500, body: { code: 'LEAD_SAVE_FAILED', error: 'Не вдалося зберегти заявку. Напишіть на support@trip-control.com.' } };
    try {
        await deps.sendMail(buildLeadEmail(checked.lead));
    } catch (e) {
        console.warn('kp-lead mail failed:', e && (e.code || e.message));
    }
    return { status: 200, body: { ok: true } };
}
