// POST /api/contracts/sign — скан і підписання договору. Тіло { contract_id, method: 'scan' | 'image' | 'kep', path? | sig_path?, name? }; GET → { kep }.
//  * scan: додати скан. Організація з шляху звіряється з організацією користувача ДО читання файлу службовою роллю, тип файлу
//    перевіряється за magic bytes (PDF / JPG / PNG, не за розширенням чи MIME від клієнта); файл не того типу видаляється з бакета.
//  * image: зображення підпису й печатки з реквізитів на скан (право «Договори» + «Підпис і печатка» — перевіряє RPC
//    kp_contract_sign_context від імені користувача; без права 403). Результат — signed-<uuid>.pdf у приватному бакеті,
//    запис службовою роллю (kp_contract_set_signed) + сповіщення директору, якщо підписав логіст.
//  * kep: .p7s (відокремлений CAdES), підписаний на id.gov.ua чи іншим засобом КЕП і завантажений у бакет. Сервер перевіряє
//    ФОРМАТ файлу, потім RPC kp_contract_attach_sig від імені користувача (права + статус). Криптографічну перевірку підпису
//    сервер НЕ виконує — це робить ЦСК / id.gov.ua.
//  * GET: чи налаштований віджет КЕП (env KEP_WIDGET_URL) і посилання на сервіс підпису id.gov.ua/sign.
import { looksLikeP7s, mimeOfPath, stampContract, typeMatchesPath } from './stamp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN = /KP_FORBIDDEN|CONTROL_PLUS_REQUIRED|MEMBER_PERMISSION_DENIED|CONTRACT_NOT_FOUND/;

export function kepConfig(env) {
    const widget = String((env && env.KEP_WIDGET_URL) || '').trim();
    let origin = null;
    try {
        origin = /^https:\/\//.test(widget) ? new URL(widget).origin : null;
    } catch {
        origin = null;
    }
    return { widget_url: origin ? widget : null, widget_origin: origin, sign_url: 'https://id.gov.ua/sign' };
}

// deps: getUser, getSignContext(jwt, id), getScanContext(jwt, id), loadFile(path), removeFile(path), attachScan(actorId, id, path, name), loadAsset(path), saveSigned(path, bytes), setSigned(id, userId, path),
// attachSig(actorId, id, path) (service, p_actor; throw з message бази), newId(), env
export function createSignHandler(deps) {
    const { env = {}, log = console } = deps;
    return async function signHandler(req, res) {
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
        if (req.method === 'GET') return res.status(200).json({ kep: kepConfig(env) });

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const id = String(body.contract_id || '');
        if (!UUID.test(id)) return res.status(400).json({ code: 'BAD_REQUEST', error: 'Не вказано договір.' });
        const method = String(body.method || '');
        if (method !== 'image' && method !== 'kep' && method !== 'scan') return res.status(400).json({ code: 'BAD_REQUEST', error: 'Невідомий спосіб підпису.' });

        const mapError = (error) => {
            const message = String((error && error.message) || '');
            if (FORBIDDEN.test(message)) return [403, { code: 'FORBIDDEN', error: 'Немає права підписувати цей договір (потрібні «Договори» та «Підпис і печатка»).' }];
            if (/CONTRACT_LOCKED/.test(message)) return [409, { code: 'CONTRACT_LOCKED', error: 'Договір уже підписано.' }];
            if (/CONTRACT_FILE_MISSING/.test(message)) return [409, { code: 'CONTRACT_FILE_MISSING', error: 'Спершу завантажте скан договору.' }];
            if (/CONTRACT_FILE_BAD|CONTRACT_FILE_TOO_BIG/.test(message)) return [400, { code: 'CONTRACT_FILE_BAD', error: 'Файл підпису не прийнято.' }];
            return [502, { code: 'SIGN_FAILED', error: 'Не вдалося підписати договір. Спробуйте ще раз.' }];
        };

        if (method === 'scan') {
            const path = String(body.path || '');
            if (!new RegExp('^[0-9a-f-]{36}/' + id + '/scan-[0-9a-f-]{36}[.](pdf|jpg|png)$', 'i').test(path)) return res.status(400).json({ code: 'CONTRACT_FILE_BAD', error: 'Файл не прийнято.' });
            let scanCtx;
            try {
                scanCtx = await deps.getScanContext(jwt, id);
            } catch (error) {
                const [status, payload] = mapError(error);
                return res.status(status).json(payload);
            }
            // Організація шляху — до читання файлу службовою роллю.
            if (!scanCtx || path.split('/')[0].toLowerCase() !== String(scanCtx.org_id).toLowerCase()) return res.status(403).json({ code: 'FORBIDDEN', error: 'Файл належить іншій організації.' });
            let scan = null;
            try {
                scan = await deps.loadFile(path);
            } catch {
                scan = null;
            }
            if (!scan) return res.status(409).json({ code: 'CONTRACT_FILE_MISSING', error: 'Скан не знайдено. Завантажте його ще раз.' });
            if (scan.length > 10 * 1024 * 1024) {
                await deps.removeFile(path).catch(() => {});
                return res.status(413).json({ code: 'CONTRACT_FILE_TOO_BIG', error: 'Файл більший за 10 МБ.' });
            }
            if (!typeMatchesPath(scan, path)) {
                await deps.removeFile(path).catch(() => {});
                return res.status(415).json({ code: 'BAD_FILE_TYPE', error: 'Вміст файлу не відповідає PDF, JPG чи PNG. Завантажте справжній скан.' });
            }
            try {
                await deps.attachScan(user.id, id, path, String(body.name || '').slice(0, 200));
            } catch (error) {
                const [status, payload] = mapError(error);
                return res.status(status).json(payload);
            }
            return res.status(200).json({ ok: true, method: 'scan', path });
        }

        if (method === 'kep') {
            const path = String(body.sig_path || '');
            if (!new RegExp('^[0-9a-f-]{36}/' + id + '/sig-[0-9a-f-]{36}[.]p7s$', 'i').test(path)) return res.status(400).json({ code: 'CONTRACT_FILE_BAD', error: 'Файл підпису не прийнято.' });
            let kepCtx;
            try {
                kepCtx = await deps.getSignContext(jwt, id);
            } catch (error) {
                const [status, payload] = mapError(error);
                return res.status(status).json(payload);
            }
            // Організація з шляху .p7s має збігатися з організацією користувача ДО будь-якого читання файлу службовою роллю.
            if (!kepCtx || path.split('/')[0].toLowerCase() !== String(kepCtx.org_id).toLowerCase()) return res.status(403).json({ code: 'FORBIDDEN', error: 'Файл підпису належить іншій організації.' });
            let bytes = null;
            try {
                bytes = await deps.loadFile(path);
            } catch {
                bytes = null;
            }
            if (!bytes) return res.status(409).json({ code: 'CONTRACT_FILE_MISSING', error: 'Файл підпису (.p7s) не знайдено. Завантажте його ще раз.' });
            if (!looksLikeP7s(bytes)) return res.status(422).json({ code: 'BAD_P7S', error: 'Це не схоже на відокремлений підпис CAdES (.p7s). Підпишіть файл договору на id.gov.ua/sign й завантажте .p7s.' });
            try {
                await deps.attachSig(user.id, id, path);
            } catch (error) {
                const [status, payload] = mapError(error);
                return res.status(status).json(payload);
            }
            return res.status(200).json({ ok: true, method: 'kep' });
        }

        let ctx;
        try {
            ctx = await deps.getSignContext(jwt, id);
        } catch (error) {
            const [status, payload] = mapError(error);
            return res.status(status).json(payload);
        }
        try {
            const [bytes, signature, stamp] = await Promise.all([deps.loadFile(ctx.file_path), deps.loadAsset(ctx.signature_path), deps.loadAsset(ctx.stamp_path)]);
            if (!bytes) return res.status(409).json({ code: 'CONTRACT_FILE_MISSING', error: 'Скан договору не знайдено. Завантажте його ще раз.' });
            if (!signature && !stamp) return res.status(409).json({ code: 'NO_ASSETS', error: 'У реквізитах немає підпису й печатки. Завантажте їх у вкладці «Реквізити».' });
            if (!typeMatchesPath(bytes, ctx.file_path)) return res.status(415).json({ code: 'BAD_FILE_TYPE', error: 'Вміст скану не відповідає PDF, JPG чи PNG. Завантажте справжній скан.' });
            const signed = await stampContract({ bytes, mime: mimeOfPath(ctx.file_path), signature, stamp });
            const path = ctx.org_id + '/' + id + '/signed-' + deps.newId() + '.pdf';
            await deps.saveSigned(path, signed);
            await deps.setSigned(id, user.id, path);
            return res.status(200).json({ ok: true, method: 'image', path });
        } catch (error) {
            if (error && error.code === 'CONTRACT_PDF_UNSUPPORTED') {
                return res.status(422).json({ code: 'CONTRACT_PDF_UNSUPPORTED', error: 'Цей PDF не вдається підписати (зашифрований або пошкоджений). Завантажте інший скан.' });
            }
            log.warn('[contracts/sign] FAILED');
            const [status, payload] = mapError(error);
            return res.status(status).json(payload);
        }
    };
}
