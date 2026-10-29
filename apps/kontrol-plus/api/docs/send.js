// GET|POST /api/docs/send — відправка актів і рахунків на пошту (Resend). Статичний файл: реальний файл у api/ має пріоритет над
// rewrite /api/:path* → trip-control.com. Логіка — lib/docs/send.js. Env (Vercel, проєкт kontrol-plus):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — як у /api/docs/assets;
//   RESEND_API_KEY — ключ API Resend (лише на сервері), EMAIL_FROM — відправник з підтвердженого домену, напр. docs@trip-control.com.
// Без RESEND_API_KEY / EMAIL_FROM відповідь 503 EMAIL_NOT_CONFIGURED («Пошта не налаштована»), нічого не падає.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { createResendSender, createSendHandler, mailConfigured } from '../../lib/docs/send.js';

const BUCKET = 'kp-doc-assets';
const NO_SESSION = { persistSession: false, autoRefreshToken: false };
const FONT_DIR = new URL('../../public/fonts/', import.meta.url);
let handler = null;

export default async function docsSend(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише GET і POST.' });
    }
    const auth = String((req.headers && req.headers.authorization) || '');
    if (!auth.startsWith('Bearer ') || auth.length <= 7) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'Потрібно увійти.' });
    }
    if (!handler) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Відправка документів ще не налаштована на сервері.' });
        }
        const supabase = createClient(url, key, { auth: NO_SESSION });
        const [pdf, docs] = await Promise.all([import('../../src/lib/pdf-docs.js'), import('../../src/lib/docs.js')]);
        const sendMail = mailConfigured(process.env) ? createResendSender(String(process.env.RESEND_API_KEY).trim()) : async () => { throw new Error('not configured'); };
        handler = createSendHandler({
            env: process.env,
            getUser: async (jwt) => {
                const { data, error } = await supabase.auth.getUser(jwt);
                return error || !data ? null : data.user;
            },
            getContext: async (jwt, docId) => {
                const asUser = createClient(url, key, { auth: NO_SESSION, global: { headers: { Authorization: 'Bearer ' + jwt } } });
                const { data, error } = await asUser.rpc('kp_doc_email_context', { p_doc: docId });
                if (error) throw new Error(String(error.message || 'context'));
                return data;
            },
            getContractContext: async (jwt, id) => {
                const asUser = createClient(url, key, { auth: NO_SESSION, global: { headers: { Authorization: 'Bearer ' + jwt } } });
                const { data, error } = await asUser.rpc('kp_contract_email_context', { p_id: id });
                if (error) throw new Error(String(error.message || 'context'));
                return data;
            },
            loadFile: async (path) => {
                if (!path) return null;
                const { data, error } = await supabase.storage.from('kp-contracts').download(path);
                return error || !data ? null : new Uint8Array(await data.arrayBuffer());
            },
            markContractSent: async (id) => {
                await supabase.rpc('kp_contract_mark_sent', { p_id: id });
            },
            loadAsset: async (path) => {
                if (!path) return null;
                const { data, error } = await supabase.storage.from(BUCKET).download(path);
                if (error || !data) return null;
                return new Uint8Array(await data.arrayBuffer());
            },
            loadFonts: async () => ({
                regular: new Uint8Array(fs.readFileSync(new URL('NotoSans-Regular.ttf', FONT_DIR))),
                bold: new Uint8Array(fs.readFileSync(new URL('NotoSans-Bold.ttf', FONT_DIR))),
            }),
            buildPdf: (doc, options) => pdf.buildDocPdf(doc, options),
            fileName: (doc) => docs.docFileName(doc),
            docAssetPaths: (doc) => docs.docAssetPaths(doc),
            reserve: async (row, limit) => {
                const { data, error } = await supabase.rpc('kp_mail_reserve', { p_org: row.org_id, p_doc_ids: row.doc_ids, p_sent_by: row.sent_by, p_to: row.to_email, p_subject: row.subject, p_limit: limit, p_contract_id: row.contract_id || null });
                if (error || !data) throw new Error(String((error && error.message) || 'reserve'));
                return data;
            },
            logFinish: async (id, patch) => {
                const { error } = await supabase.from('kp_doc_emails').update(patch).eq('id', id);
                if (error) throw new Error('log');
            },
            sendMail,
        });
    }
    return handler(req, res);
}
