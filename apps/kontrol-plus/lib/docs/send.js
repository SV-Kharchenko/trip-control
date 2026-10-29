// Відправка актів і рахунків на пошту (Resend). GET /api/docs/send → { configured } (кнопка знає, чи є пошта).
// POST { doc_ids: [1…5], to, subject, text } → лист із PDF-вкладеннями. Усе — на сервері: JWT користувача, перевірка документа
// своєї організації й права «акти» (RPC kp_doc_email_context від імені користувача), ліміт 20 листів на годину на організацію,
// PDF тим самим шаблоном, що й у браузері (src/lib/pdf-docs.js, з підписом і печаткою, якщо вони є в самому документі), лог у
// kp_doc_emails. Ключ і відправник — лише з env (RESEND_API_KEY, EMAIL_FROM); без них — 503 EMAIL_NOT_CONFIGURED, без падіння.
// Усі залежності (база, Resend, PDF) передаються ззовні, щоб логіку можна було перевірити без мережі.
export const HOURLY_LIMIT = 20;
export const MAX_DOCS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s,;<>()"]+@[^@\s,;<>()"]+\.[^@\s,;<>()"]+$/;

export const NOT_CONFIGURED = { code: 'EMAIL_NOT_CONFIGURED', error: 'Пошта не налаштована. Зверніться до адміністратора.' };

export function mailConfigured(env) {
    return Boolean(env && String(env.RESEND_API_KEY || '').trim() && String(env.EMAIL_FROM || '').trim());
}

const FORBIDDEN = /DOC_NOT_FOUND|KP_FORBIDDEN|CONTROL_PLUS_REQUIRED|MEMBER_PERMISSION_DENIED/;

function cleanLine(value, max) {
    return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Перевірка тіла запиту. → { ok, value } або { ok: false, error }.
export function parseSendBody(body) {
    const b = body && typeof body === 'object' ? body : {};
    const ids = Array.isArray(b.doc_ids) ? b.doc_ids.map(String) : [];
    if (!ids.length || ids.length > MAX_DOCS || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) {
        return { ok: false, error: 'Оберіть від 1 до ' + MAX_DOCS + ' документів.' };
    }
    const to = cleanLine(b.to, 254).toLowerCase();
    if (!EMAIL.test(to)) return { ok: false, error: 'Вкажіть коректну пошту одержувача.' };
    const subject = cleanLine(b.subject, 200);
    if (!subject) return { ok: false, error: 'Вкажіть тему листа.' };
    const text = String(b.text == null ? '' : b.text).replace(/\r\n/g, '\n').slice(0, 5000);
    return { ok: true, value: { ids, to, subject, text } };
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// deps: getUser(jwt) → user|null; getContext(jwt, docId) → context (throw з message бази); loadAsset(path) → bytes|null;
// loadFonts() → { regular, bold }; buildPdf(doc, { fonts, images }) → { bytes }; fileName(doc) → string;
// countRecent(orgId, sinceIso) → number; logStart(row) → id; logFinish(id, patch); sendMail(payload) → { id } (throw { message });
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
        const { ids, to, subject, text } = parsed.value;

        const contexts = [];
        for (const id of ids) {
            try {
                contexts.push(await deps.getContext(jwt, id));
            } catch (error) {
                const message = String((error && error.message) || '');
                if (FORBIDDEN.test(message)) return res.status(403).json({ code: 'FORBIDDEN', error: 'Недостатньо прав для відправки цього документа.' });
                if (/DOC_CANCELLED/.test(message)) return res.status(409).json({ code: 'DOC_CANCELLED', error: 'Анульований документ не відправляється.' });
                if (/DOC_BAD_KIND/.test(message)) return res.status(400).json({ code: 'BAD_KIND', error: 'На пошту відправляються лише акти й рахунки.' });
                log.warn('[docs/send] CONTEXT_FAILED');
                return res.status(502).json({ code: 'CONTEXT_FAILED', error: 'Не вдалося перевірити документ. Спробуйте ще раз.' });
            }
        }
        const orgId = contexts[0].org_id;
        if (!orgId || contexts.some((c) => c.org_id !== orgId)) return res.status(403).json({ code: 'FORBIDDEN', error: 'Недостатньо прав для відправки цього документа.' });

        const since = new Date(now() - 60 * 60 * 1000).toISOString();
        let recent;
        try {
            recent = await deps.countRecent(orgId, since);
        } catch {
            return res.status(502).json({ code: 'LIMIT_CHECK_FAILED', error: 'Не вдалося перевірити ліміт відправок. Спробуйте ще раз.' });
        }
        if (recent >= HOURLY_LIMIT) {
            res.setHeader('Retry-After', '3600');
            return res.status(429).json({ code: 'RATE_LIMIT', error: 'Ліміт: ' + HOURLY_LIMIT + ' листів на годину. Спробуйте пізніше.', limit: HOURLY_LIMIT });
        }

        let logId = null;
        try {
            logId = await deps.logStart({ org_id: orgId, doc_ids: ids, sent_by: user.id, to_email: to, subject, status: 'queued' });
        } catch {
            return res.status(502).json({ code: 'LOG_FAILED', error: 'Не вдалося записати відправку в журнал. Лист не надіслано.' });
        }
        const finish = (patch) => deps.logFinish(logId, { ...patch, finished_at: new Date(now()).toISOString() }).catch(() => {});

        let attachments;
        try {
            const fonts = await deps.loadFonts();
            attachments = [];
            for (const ctx of contexts) {
                const paths = deps.docAssetPaths(ctx.doc);
                const [signature, stamp] = await Promise.all([deps.loadAsset(paths.signature), deps.loadAsset(paths.stamp)]);
                const { bytes } = await deps.buildPdf(ctx.doc, { fonts, images: { signature, stamp } });
                attachments.push({ filename: deps.fileName(ctx.doc), content: b64(bytes) });
            }
        } catch {
            log.warn('[docs/send] PDF_FAILED');
            await finish({ status: 'failed', error: 'Не вдалося сформувати PDF' });
            return res.status(500).json({ code: 'PDF_FAILED', error: 'Не вдалося сформувати PDF. Лист не надіслано.' });
        }

        const first = contexts[0];
        const payload = {
            from: String(env.EMAIL_FROM).trim(),
            to: [to],
            subject,
            text: text || subject,
            attachments,
        };
        if (first.reply_to && EMAIL.test(String(first.reply_to))) payload.reply_to = String(first.reply_to);
        try {
            const sent = await deps.sendMail(payload);
            await finish({ status: 'sent', provider_id: sent && sent.id ? String(sent.id).slice(0, 100) : null });
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
