// Виклик серверного GPS API Контроль+ (/api/gps/<route>) з JWT сесії сайту. Нічого не зберігає в браузері.
// Відповідь з помилкою повертається повністю (у 429 карти — ще й дані з кешу).
export async function callGpsApi(app, route, body) {
    const { data } = await app.supabase.auth.getSession();
    const jwt = data && data.session && data.session.access_token;
    if (!jwt) return { ok: false, status: 401, error: 'Сесія завершилась — увійдіть ще раз.' };
    let res;
    try {
        res = await fetch('/api/gps/' + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
            body: JSON.stringify(body || {}),
            cache: 'no-store',
        });
    } catch {
        return { ok: false, status: 0, network: true, error: 'Немає зʼєднання з сервером. Перевірте інтернет.' };
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ...json, ok: false, status: res.status, error: json.error || 'Не вдалося виконати дію. Спробуйте ще раз.' };
    return { ok: true, status: res.status, ...json };
}
