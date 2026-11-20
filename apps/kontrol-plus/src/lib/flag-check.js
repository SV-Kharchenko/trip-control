// Перевірка булевого доступу користувача через RPC (is_platform_superadmin, agro_access_me) з трьома результатами: true, false і ERROR.
// Кешується лише точна відповідь (true / false); помилка (мережа, токен ще не готовий) нічого не кешує й не перезаписує вже відоме значення,
// а запускає до трьох повторів із затримкою 1 с, 3 с і 10 с — лише поки той самий користувач залогінений. Це лише підказка інтерфейсу:
// справжню перевірку робить база.
export const ERROR = 'error';
export const RETRY_DELAYS = [1000, 3000, 10000];

// Результат RPC → true | false | ERROR. Лише `data === true / false` без помилки вважається точною відповіддю.
export function parseFlag(response) {
    if (!response || response.error) return ERROR;
    if (response.data === true) return true;
    if (response.data === false) return false;
    return ERROR;
}

// query() → Promise<true|false|ERROR>; userId() — id поточного користувача (або null); cachedUser() — для кого вже є точна відповідь;
// onResolve(value, uid) — записати точну відповідь у стан і перемалювати меню.
export function createFlagCheck({ query, userId, cachedUser, onResolve, delays = RETRY_DELAYS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null;
    let inflight = null; // { uid, promise }

    function cancel() {
        if (timer !== null) clearTimer(timer);
        timer = null;
    }

    async function run(uid, attempt) {
        let result;
        try {
            result = await query();
        } catch {
            result = ERROR;
        }
        if (userId() !== uid) return { error: false, stale: true };
        if (result === ERROR) {
            if (attempt < delays.length) {
                cancel();
                timer = setTimer(() => {
                    timer = null;
                    if (userId() !== uid || cachedUser() === uid) return;
                    run(uid, attempt + 1);
                }, delays[attempt]);
            }
            return { error: true };
        }
        cancel();
        onResolve(result, uid);
        return { error: false, value: result };
    }

    // Є точна відповідь для користувача — нічого не питаємо. Інакше питаємо (один запит на користувача одночасно).
    function ensure() {
        const uid = userId();
        if (!uid) return Promise.resolve({ error: false, stale: true });
        if (cachedUser() === uid) return Promise.resolve({ error: false, cached: true });
        if (inflight && inflight.uid === uid) return inflight.promise;
        cancel();
        const promise = run(uid, 0).finally(() => { if (inflight && inflight.promise === promise) inflight = null; });
        inflight = { uid, promise };
        return promise;
    }

    // Подія (вхід, оновлення токена, повернення у вкладку, online): кеш порожній через помилку — питаємо знову, лічильник спроб з нуля.
    function recheck() {
        const uid = userId();
        if (!uid || cachedUser() === uid) return Promise.resolve({ error: false, cached: true });
        cancel();
        return ensure();
    }

    return { ensure, recheck, cancel, pending: () => timer !== null };
}
