// GET|POST /api/contracts/sign — підписання договору (зображення підпису й печатки або КЕП .p7s). Логіка — lib/contracts/sign.js.
// Env (Vercel, проєкт kontrol-plus): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — як у /api/docs/*; необов'язково KEP_WIDGET_URL
// (https-адреса віджета КЕП; див. docs/CONTRACTS-KEP.md). Без KEP_WIDGET_URL працює підписання через id.gov.ua/sign + завантаження .p7s.
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createSignHandler } from '../../lib/contracts/sign.js';

const NO_SESSION = { persistSession: false, autoRefreshToken: false };
let handler = null;

export default async function contractsSign(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише GET і POST.' });
    }
    const auth = String((req.headers && req.headers.authorization) || '');
    if (!auth.startsWith('Bearer ') || auth.length <= 7) return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'Потрібно увійти.' });
    if (!handler) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) return res.status(503).json({ code: 'NOT_CONFIGURED', error: 'Підписання договорів ще не налаштоване на сервері.' });
        const supabase = createClient(url, key, { auth: NO_SESSION });
        const asUser = (jwt) => createClient(url, key, { auth: NO_SESSION, global: { headers: { Authorization: 'Bearer ' + jwt } } });
        const download = async (bucket, path) => {
            if (!path) return null;
            const { data, error } = await supabase.storage.from(bucket).download(path);
            return error || !data ? null : new Uint8Array(await data.arrayBuffer());
        };
        handler = createSignHandler({
            env: process.env,
            getUser: async (jwt) => {
                const { data, error } = await supabase.auth.getUser(jwt);
                return error || !data ? null : data.user;
            },
            getScanContext: async (jwt, id) => {
                const { data, error } = await asUser(jwt).rpc('kp_contract_scan_context', { p_id: id });
                if (error) throw new Error(String(error.message || 'context'));
                return data;
            },
            removeFile: async (path) => {
                await supabase.storage.from('kp-contracts').remove([path]);
            },
            attachScan: async (jwt, id, path, name) => {
                const { error } = await asUser(jwt).rpc('kp_contract_attach', { p_id: id, p_path: path, p_name: name });
                if (error) throw new Error(String(error.message || 'attach'));
            },
            getSignContext: async (jwt, id) => {
                const { data, error } = await asUser(jwt).rpc('kp_contract_sign_context', { p_id: id });
                if (error) throw new Error(String(error.message || 'context'));
                return data;
            },
            loadFile: (path) => download('kp-contracts', path),
            loadAsset: (path) => download('kp-doc-assets', path),
            saveSigned: async (path, bytes) => {
                const { error } = await supabase.storage.from('kp-contracts').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
                if (error) throw new Error('upload');
            },
            setSigned: async (id, userId, path) => {
                const { error } = await supabase.rpc('kp_contract_set_signed', { p_id: id, p_user: userId, p_path: path, p_method: 'image' });
                if (error) throw new Error(String(error.message || 'set'));
            },
            attachSig: async (jwt, id, path) => {
                const { error } = await asUser(jwt).rpc('kp_contract_attach_sig', { p_id: id, p_path: path });
                if (error) throw new Error(String(error.message || 'attach'));
            },
            newId: randomUUID,
        });
    }
    return handler(req, res);
}
