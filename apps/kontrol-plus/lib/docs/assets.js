// Знімок підпису й печатки для нового документа (етап 4a): POST {} → { doc_id, signature_path, stamp_path }.
// Сервер бере поточні файли реквізитів (kp_doc_assets_source від імені користувача — лише owner / logist) і копіює їх
// service_role у <org>/docs/<doc_id>/(signature|stamp).(png|jpg). Потім клієнт викликає kp_doc_create(p_id = doc_id):
// документ посилається лише на свою копію, тож заміна чи видалення підпису в реквізитах виданих документів не змінює.
// Копія не перезаписує наявний файл. У логи — лише код помилки, без JWT і шляхів.
import { randomUUID } from 'node:crypto';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ASSET_KINDS = ['signature', 'stamp'];

// Шлях знімка в документі для файлу реквізитів: '<org>/signature.png' → '<org>/docs/<doc>/signature.png'.
// null — у реквізитах файлу немає; Error — шлях не з цієї організації або не той формат (не копіюємо).
export function snapshotPath(orgId, docId, kind, source) {
    if (!source) return null;
    const m = new RegExp('^(' + UUID + ')/' + kind + '\\.(png|jpg)$').exec(String(source));
    if (!m || m[1] !== orgId) throw Object.assign(new Error('BAD_SOURCE'), { code: 'BAD_SOURCE' });
    return orgId + '/docs/' + docId + '/' + kind + '.' + m[2];
}

const FORBIDDEN = /KP_FORBIDDEN|CONTROL_PLUS_REQUIRED/;

// getUser(jwt) → користувач або null; getSource(jwt) → { org_id, signature_path, stamp_path } (RPC від імені
// користувача; помилка — throw з message бази); copy(from, to) → throw, якщо не вдалося (err.notFound — немає джерела).
export function createAssetsHandler({ getUser, getSource, copy, newId = randomUUID, log = console }) {
    return async function assetsHandler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Дозволено лише POST.' });
        }
        const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        if (!header.startsWith('Bearer ') || header.length <= 7) return res.status(401).json({ code: 'AUTH_REQUIRED', error: 'Потрібно увійти.' });
        const jwt = header.slice(7);
        let user = null;
        try {
            user = await getUser(jwt);
        } catch {
            user = null;
        }
        if (!user) return res.status(401).json({ code: 'BAD_TOKEN', error: 'Сесія завершилась — увійдіть ще раз.' });

        let source;
        try {
            source = await getSource(jwt);
        } catch (error) {
            if (FORBIDDEN.test(String((error && error.message) || ''))) {
                return res.status(403).json({ code: 'KP_FORBIDDEN', error: 'Недостатньо прав для цієї дії.' });
            }
            log.warn('[docs/assets] SOURCE_FAILED');
            return res.status(502).json({ code: 'ASSETS_FAILED', error: 'Не вдалося підготувати підпис і печатку. Спробуйте ще раз.' });
        }
        if (!source || !source.org_id) return res.status(403).json({ code: 'KP_FORBIDDEN', error: 'Недостатньо прав для цієї дії.' });

        const docId = newId();
        const out = { doc_id: docId, signature_path: null, stamp_path: null };
        try {
            for (const kind of ASSET_KINDS) {
                const to = snapshotPath(source.org_id, docId, kind, source[kind + '_path']);
                if (!to) continue;
                await copy(source[kind + '_path'], to);
                out[kind + '_path'] = to;
            }
        } catch (error) {
            const missing = Boolean(error && error.notFound);
            log.warn('[docs/assets] ' + (missing ? 'SOURCE_MISSING' : (error && error.code) || 'COPY_FAILED'));
            if (missing) {
                return res.status(409).json({ code: 'ASSET_SOURCE_MISSING', error: 'Файл підпису чи печатки не знайдено — завантажте його знову в реквізитах.' });
            }
            return res.status(502).json({ code: 'ASSETS_FAILED', error: 'Не вдалося підготувати підпис і печатку. Спробуйте ще раз.' });
        }
        return res.status(200).json(out);
    };
}
