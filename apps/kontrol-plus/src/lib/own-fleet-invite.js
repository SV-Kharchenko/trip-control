// Запрошення замовника підрозділу (?requester_invite=…): той самий порядок, що в запрошенні відповідального за ремонти (bridge.js),
// але окремий ключ, параметр і API (/api/own-fleet/invites). Параметр одразу прибираємо з URL; без сесії токен чекає в localStorage
// (реєстрація з підтвердженням пошти відкриває сайт без параметра) до 7 днів; після входу — accept; ключ видаляємо за будь-якої
// відповіді сервера. Токен не логуємо. Залежності передаються ззовні, щоб логіку можна було перевірити без браузера.
export const REQUESTER_INVITE_KEY = 'kp_requester_invite';
export const REQUESTER_INVITE_PARAM = 'requester_invite';
export const REQUESTER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUESTER_INVITE_LOGIN_HINT = 'Увійдіть або зареєструйтеся тією поштою, на яку прийшло запрошення. '
    + 'Після підтвердження пошти запрошення буде прийнято автоматично.';

export function takeRequesterInviteFromUrl(win) {
    let url;
    try {
        url = new URL(win.location.href);
    } catch {
        return null;
    }
    const token = url.searchParams.get(REQUESTER_INVITE_PARAM);
    if (!token) return null;
    url.searchParams.delete(REQUESTER_INVITE_PARAM);
    win.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return token;
}

export function storedRequesterInvite(storage, now = Date.now()) {
    try {
        const raw = storage.getItem(REQUESTER_INVITE_KEY);
        if (raw === null) return null;
        const saved = JSON.parse(raw);
        const age = now - Number(saved && saved.at);
        if (saved && typeof saved.token === 'string' && saved.token && age >= 0 && age < REQUESTER_INVITE_TTL_MS) return saved.token;
        storage.removeItem(REQUESTER_INVITE_KEY);
    } catch {
        try { storage.removeItem(REQUESTER_INVITE_KEY); } catch { /* сховище заблоковане */ }
    }
    return null;
}

// deps: { win, storage, hasSession(), call(path, body) → { ok, network, error, org_name }, hint(text, kind), onAccepted(orgName) }
export function createRequesterInviteAcceptor(deps) {
    let inFlight = null;
    const forget = () => {
        try { if (deps.storage.getItem(REQUESTER_INVITE_KEY) !== null) deps.storage.removeItem(REQUESTER_INVITE_KEY); } catch { /* сховище заблоковане */ }
    };
    async function once() {
        const fromUrl = takeRequesterInviteFromUrl(deps.win);
        if (fromUrl && !deps.hasSession()) {
            try {
                deps.storage.setItem(REQUESTER_INVITE_KEY, JSON.stringify({ token: fromUrl, at: Date.now() }));
            } catch { /* приватний режим: після входу посилання доведеться відкрити ще раз */ }
            deps.hint(REQUESTER_INVITE_LOGIN_HINT, 'info');
            return false;
        }
        if (!deps.hasSession()) return false;
        const token = fromUrl || storedRequesterInvite(deps.storage);
        if (!token) return false;
        const out = await deps.call('/api/own-fleet/invites', { action: 'accept', token });
        if (!out.network) forget();
        if (!out.ok) {
            deps.hint(out.error || 'Не вдалося прийняти запрошення.', 'error');
            return false;
        }
        await deps.onAccepted(out.org_name || '');
        return true;
    }
    // Старт і onAuthStateChange можуть викликати це майже одночасно: другий виклик отримує той самий Promise.
    return function accept() {
        if (!inFlight) inFlight = once().finally(() => { inFlight = null; });
        return inFlight;
    };
}
