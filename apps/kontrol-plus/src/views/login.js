import { h, notice } from '../ui.js';
import { errorText } from '../lib/errors.js';

export function renderLogin({ supabase, siteUrl }) {
    const message = h('div', { class: 'form-message', 'aria-live': 'polite' });
    const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true, id: 'login-email' });
    const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, id: 'login-password' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Увійти');

    const form = h('form', {
        class: 'card login-card',
        onsubmit: async (event) => {
            event.preventDefault();
            message.replaceChildren();
            submit.disabled = true;
            submit.textContent = 'Входимо…';
            const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
            submit.disabled = false;
            submit.textContent = 'Увійти';
            if (error) message.append(notice(errorText(error)));
            // Успіх обробляє onAuthStateChange у main.js.
        },
    },
    h('img', { src: '/icons/icon-192.png', width: 64, height: 64, alt: '', class: 'login-logo' }),
    h('h1', null, 'Контроль', h('b', null, '+')),
    h('p', { class: 'muted' }, 'Увійдіть тим самим акаунтом, що й на trip-control.com.'),
    h('label', { for: 'login-email' }, 'Email'), email,
    h('label', { for: 'login-password' }, 'Пароль'), password,
    message,
    submit,
    h('p', { class: 'muted small' },
        'Немає акаунта або забули пароль? ',
        h('a', { href: siteUrl + '/', target: '_blank', rel: 'noopener' }, 'Перейдіть на trip-control.com')));

    return h('main', { class: 'login-wrap' }, form);
}
