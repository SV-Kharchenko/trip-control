import { h } from './ui.js';

// На localhost SW не реєструємо (і знімаємо старий) — щоб розробка завжди бачила свіжі файли.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

export function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (LOCAL.includes(location.hostname)) {
        navigator.serviceWorker.getRegistrations().then((list) => list.forEach((reg) => reg.unregister())).catch(() => {});
        return;
    }
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
            if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
            reg.addEventListener('updatefound', () => {
                const worker = reg.installing;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
                });
            });
        }).catch(() => {});
    });
}

function showUpdate(worker) {
    if (document.getElementById('update-banner')) return;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
    });
    document.body.append(h('div', { id: 'update-banner', class: 'update-banner', role: 'status' },
        h('span', null, 'Є оновлення'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => worker.postMessage({ type: 'SKIP_WAITING' }) }, 'Оновити')));
}
