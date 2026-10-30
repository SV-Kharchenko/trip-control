// Відправка актів і рахунків на пошту (Resend). GET /api/docs/send → { configured } (кнопка знає, чи є пошта).
// POST { doc_ids: [1…5], to, subject, text } → лист із PDF-вкладеннями. Усе — на сервері: JWT користувача, перевірка документа
// своєї організації й права «акти» (RPC kp_doc_email_context від імені користувача), ліміт 20 листів на годину на організацію
// (резервування рядка журналу й підрахунок в одній транзакції під advisory-замком: kp_doc_email_reserve),
// PDF тим самим шаблоном, що й у браузері (src/lib/pdf-docs.js, з підписом і печаткою, якщо вони є в самому документі), лог у
// kp_doc_emails. Ключ і відправник — лише з env (RESEND_API_KEY, EMAIL_FROM); без них — 503 EMAIL_NOT_CONFIGURED, без падіння.
// Усі залежності (база, Resend, PDF) передаються ззовні, щоб логіку можна було перевірити без мережі.
import { looksLikeP7s, typeMatchesPath } from '../contracts/stamp.js';
export const HOURLY_LIMIT = 20;
export const MAX_DOCS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s,;<>()"]+@[^@\s,;<>()"]+\.[^@\s,;<>()"]+$/;

// Антиспам: за замовчуванням лист іде лише на пошту контрагента з картки. Інша адреса — тільки з явним підтвердженням
// (other_address: true) і лише від директора (owner); логіст іншу адресу не може. Футер додає сервер, клієнт його не прибирає.
export const OTHER_ADDRESS_ROLES = ['owner'];

export function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function mailFooter(orgName) {
    return 'Надіслано через TripControl від ' + (cleanLine(orgName, 200) || 'організації');
}

// Текст і HTML листа: текст користувача лише екранований, футер дописує сервер.
export function composeBody(text, orgName) {
    const footer = mailFooter(orgName);
    const body = String(text || '').trim();
    return {
        text: (body ? body + '\n\n' : '') + '--\n' + footer,
        html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' + (body ? '<p>' + escapeHtml(body).replace(/\n/g, '<br>') + '</p>' : '')
            + '<hr style="border:0;border-top:1px solid #ccc;margin:16px 0"><p style="color:#666;font-size:12px">' + escapeHtml(footer) + '</p></div>',
    };
}

export const NOT_CONFIGURED = { code: 'EMAIL_NOT_CONFIGURED', error: 'Пошта не налаштована. Зверніться до адміністратора.' };

export function mailConfigured(env) {
    return Boolean(env && String(env.RESEND_API_KEY || '').trim() && String(env.EMAIL_FROM || '').trim());
}

const FORBIDDEN = /DOC_NOT_FOUND|KP_FORBIDDEN|CONTROL_PLUS_REQUIRED|MEMBER_PERMISSION_DENIED/;

function cleanLine(value, max) {
    return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Перевірка тіла запиту. → { ok, value } або { ok: false, error }. Або doc_ids (акти / рахунки), або contract_id (договір).
export function parseSendBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const ids = Array.isArray(b.doc_ids) ? b.doc_ids.map(String) : [];
    const contractId = b.contract_id === undefined || b.contract_id === null ? null : String(b.contract_id);
    if (contractId !== null) {
        if (!UUID.test(contractId) || ids.length) return { ok: false, error: 'Оберіть договір або документи, не разом.' };
    } else if (!ids.length || ids.length > MAX_DOCS || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) {
        return { ok: false, error: 'Оберіть від 1 до ' + MAX_DOCS + ' документів.' };
    }
    const to = cleanLine(b.to, 254).toLowerCase();
    if (!EMAIL.test(to)) return { ok: false, error: 'Вкажіть коректну пошту одержувача.' };
    const subject = cleanLine(b.subject, 200);
    if (!subject) return { ok: false, error: 'Вкажіть тему листа.' };
    const text = String(b.text == null ? '' : b.text).replace(/\r\n/g, '\n').slice(0, 5000);
    return { ok: true, value: { ids, contractId, to, subject, text, otherAddress: b.other_address === true } };
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// deps: getUser(jwt) → user|null; getContext(jwt, docId) → context (throw з message бази); loadAsset(path) → bytes|null;
// loadFonts() → { regular, bold }; buildPdf(doc, { fonts, images }) → { bytes }; fileName(doc) → string;
// reserve(row, limit) → id (одна транзакція: замок організації, підрахунок за годину, вставка; ліміт → throw 'RATE_LIMIT'); logFinish(id, patch); sendMail(payload) → { id } (throw { message });
// docAssetPaths(doc) → { signature, stamp }; env; now()
export function createSendHandler(deps) {
    const { env = {}, now = () => Date.now(), log = console } = deps;
    return async function sendHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET' && req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише GET і POST.' });
        }
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'Потрібно увійти.' });
        const jwt = header.slice(7);
        let user = null;
        try {
            user = await deps.getUser(jwt);
        } catch {
            user = null;
        }
        if (!user) return res.status(401).json({ code: 'BAD_TOKEN', error: 'Сесія завершилась — увійдіть ще раз.' });

        if (req.method === 'GET') return res.status(200).json({ configured: mailConfigured(env), limit: HOURLY_LIMIT });
        if (!mailConfigured(env)) return res.status(503).json(NOT_CONFIGURED);

        const parsed = parseSendBody(req.body);
        if (!parsed.ok) return res.status(400).json({ code: 'BAD_REQUEST', error: parsed.error });
        const { ids, contractId, to, subject, text, otherAddress } = parsed.value;

        const contexts = [];
        for (const id of contractId ? [contractId] : ids) {
            try {
                contexts.push(contractId ? await deps.getContractContext(jwt, id) : await deps.getContext(jwt, id));
            } catch (error) {
                const message = String((error && error.message) || '');
                if (FORBIDDEN.test(message)) return res.status(403).json({ code: 'FORBIDDEN', error: 'Недостатньо прав для відправки цього документа.' });
                if (/DOC_CANCELLED/.test(message)) return res.status(409).json({ code: 'DOC_CANCELLED', error: 'Анульований документ не відправляється.' });
                if (/CONTRACT_FILE_MISSING/.test(message)) return res.status(409).json({ code: 'CONTRACT_FILE_MISSING', error: 'У договорі немає файлу. Спершу завантажте скан.' });
                if (/DOC_BAD_KIND/.test(message)) return res.status(400).json({ code: 'BAD_KIND', error: 'На пошту відправляються лише акти й рахунки.' });
                log.warn('[docs/send] CONTEXT_FAILED');
                return res.status(502).json({ code: 'CONTEXT_FAILED', error: 'Не вдалося перевірити документ. Спробуйте ще раз.' });
            }
        }
        const orgId = contexts[0].org_id;
        if (!orgId || contexts.some((c) => c.org_id !== orgId)) return res.status(403).json({ code: 'FORBIDDEN', error: 'Недостатньо прав для відправки цього документа.' });

        // Один лист — один клієнт: усі документи мають однаковий client_id (інакше можна розіслати чужі документи на одну адресу).
        if (new Set(contexts.map((c) => String(c.doc && c.doc.client_id))).size > 1) {
            return res.status(400).json({ code: 'MIXED_CLIENTS', error: 'В одному листі можуть бути документи лише одного контрагента.' });
        }

        const first = contexts[0];
        const cardEmail = String(first.client_email || '').trim().toLowerCase();
        if (!cardEmail || to !== cardEmail) {
            if (!otherAddress) {
                return res.status(400).json({ code: 'OTHER_ADDRESS_CONFIRM', error: cardEmail ? 'Лист іде лише на пошту контрагента з картки. Щоб надіслати на іншу адресу, підтвердіть це у формі.' : 'У картці контрагента немає пошти. Щоб надіслати на іншу адресу, підтвердіть це у формі.' });
            }
            if (!OTHER_ADDRESS_ROLES.includes(String(first.sender_role || ''))) {
                return res.status(403).json({ code: 'OTHER_ADDRESS_FORBIDDEN', error: 'Іншу адресу може вказати лише директор. Додайте пошту в картку контрагента.' });
            }
        }

        let logId = null;
        try {
            logId = await deps.reserve({ org_id: orgId, doc_ids: ids, contract_id: contractId || null, sent_by: user.id, to_email: to, subject }, HOURLY_LIMIT);
        } catch (error) {
            if (/RATE_LIMIT/.test(String((error && error.message) || ''))) {
                res.setHeader('Retry-After', '3600');
                return res.status(429).json({ code: 'RATE_LIMIT', error: 'Ліміт: ' + HOURLY_LIMIT + ' листів на годину. Спробуйте пізніше.', limit: HOURLY_LIMIT });
            }
            return res.status(502).json({ code: 'LOG_FAILED', error: 'Не вдалося записати відправку в журнал. Лист не надіслано.' });
        }
        const finish = (patch) => deps.logFinish(logId, { ...patch, finished_at: new Date(now()).toISOString() }).catch(() => {});

        let attachments;
        try {
            attachments = [];
            if (contractId) {
                // Договір: підписана копія (зображення підпису й печатки) або скан, плюс відокремлений підпис .p7s, якщо є.
                const c = contexts[0].contract;
                const base = 'dogovir_' + String(c.number || 'bez-nomera').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
                const main = c.signed_path || c.file_path;
                const bytes = await deps.loadFile(main);
                if (!bytes) throw new Error('file');
                // Тип за magic bytes, не за розширенням: підроблений файл не йде в лист.
                if (!typeMatchesPath(bytes, main)) throw Object.assign(new Error('type'), { code: 'BAD_FILE_TYPE' });
                attachments.push({ filename: base + '.' + String(main).split('.').pop(), content: b64(bytes) });
                if (c.sig_path) {
                    const sig = await deps.loadFile(c.sig_path);
                    if (!sig) throw new Error('sig');
                    if (!looksLikeP7s(sig)) throw Object.assign(new Error('type'), { code: 'BAD_FILE_TYPE' });
                    attachments.push({ filename: base + '.' + String(c.file_path).split('.').pop() + '.p7s', content: b64(sig) });
                }
            }
            const fonts = contractId ? null : await deps.loadFonts();
            for (const ctx of contractId ? [] : contexts) {
                const paths = deps.docAssetPaths(ctx.doc);
                const [signature, stamp] = await Promise.all([deps.loadAsset(paths.signature), deps.loadAsset(paths.stamp)]);
                const { bytes } = await deps.buildPdf(ctx.doc, { fonts, images: { signature, stamp } });
                attachments.push({ filename: deps.fileName(ctx.doc), content: b64(bytes) });
            }
        } catch (error) {
            if (error && error.code === 'BAD_FILE_TYPE') {
                await finish({ status: 'failed', error: 'Файл договору не відповідає своєму типу' });
                return res.status(415).json({ code: 'BAD_FILE_TYPE', error: 'Вміст файлу договору не відповідає PDF, JPG чи PNG. Лист не надіслано.' });
            }
            log.warn('[docs/send] PDF_FAILED');
            await finish({ status: 'failed', error: 'Не вдалося сформувати PDF' });
            return res.status(500).json({ code: 'PDF_FAILED', error: 'Не вдалося сформувати PDF. Лист не надіслано.' });
        }

        const body = composeBody(text, first.org_name);
        const payload = {
            from: String(env.EMAIL_FROM).trim(),
            to: [to],
            subject,
            text: body.text,
            html: body.html,
            attachments,
        };
        if (first.reply_to && EMAIL.test(String(first.reply_to))) payload.reply_to = String(first.reply_to);
        try {
            const sent = await deps.sendMail(payload);
            await finish({ status: 'sent', provider_id: sent && sent.id ? String(sent.id).slice(0, 100) : null });
            if (contractId && deps.markContractSent) await deps.markContractSent(contractId).catch(() => {});
            return res.status(200).json({ ok: true, id: sent && sent.id ? String(sent.id) : null, attachments: attachments.length });
        } catch (error) {
            const reason = cleanLine((error && error.message) || 'send failed', 300);
            log.warn('[docs/send] SEND_FAILED');
            await finish({ status: 'failed', error: reason });
            return res.status(502).json({ code: 'SEND_FAILED', error: 'Пошта не прийняла лист: ' + reason });
        }
    };
}

// Resend: POST https://api.resend.com/emails (без SDK). Помилка → throw { message } без ключа.
export function createResendSender(apiKey, fetchImpl = globalThis.fetch) {
    return async function sendMail(payload) {
        const res = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error('Resend ' + res.status + (json && json.message ? ': ' + json.message : ''));
        return json;
    };
}
