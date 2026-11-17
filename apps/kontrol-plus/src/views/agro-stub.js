// Заглушка замість порожнього меню й порожнього екрана: у користувача (наприклад, «Замовник підрозділу» без власного Контроль+) не лишилось жодного пункту,
// бо «Власний парк» із меню прибрано (повніша версія — в AGRO). Кнопка веде тим самим SSO-переходом, що й кнопка «АГРО» в шапці (window.tcKpOpenAgro);
// якщо AGRO вимкнений для користувача чи компанії (window.tcKpAgro !== true) — кнопки немає, лише текст.
import { h, toast } from '../ui.js';

export const AGRO_STUB_TEXT = 'Перевезення між компаніями холдингу тепер в АГРО';
export const AGRO_STUB_BUTTON = 'Перейти в АГРО';
export const AGRO_STUB_OFF = 'Зверніться до директора за доступом до АГРО';

export function renderAgroStub(win = window) {
    let busy = false;
    const action = h('div', { class: 'kp-agro-stub-action' });
    async function open() {
        const call = win.tcKpOpenAgro;
        if (busy || typeof call !== 'function') return;
        busy = true;
        for (const btn of action.querySelectorAll('button')) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
        try {
            const out = await call();
            if (out && out.ok && typeof out.url === 'string') win.location.assign(out.url);
            else toast((out && out.error) || 'Не вдалося відкрити AGRO. Спробуйте ще раз.', 'error');
        } catch {
            toast('Не вдалося відкрити AGRO. Спробуйте ще раз.', 'error');
        } finally {
            busy = false;
            for (const btn of action.querySelectorAll('button')) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
        }
    }
    const section = h('section', { class: 'page kp-agro-stub' }, h('p', { class: 'kp-agro-stub-text' }, AGRO_STUB_TEXT), action);
    function paint() {
        action.replaceChildren(win.tcKpAgro === true
            ? h('button', { type: 'button', class: 'btn btn-primary kp-agro-stub-btn', onclick: open }, AGRO_STUB_BUTTON)
            : h('p', { class: 'muted kp-agro-stub-off' }, AGRO_STUB_OFF));
    }
    paint();
    // Доступ до AGRO підтверджується асинхронно (bridge.js): перемальовуємо, доки заглушка на екрані.
    const onAgro = () => { if (section.isConnected === false) win.removeEventListener('tc-kp-agro', onAgro); else paint(); };
    if (typeof win.addEventListener === 'function') win.addEventListener('tc-kp-agro', onAgro);
    return section;
}
