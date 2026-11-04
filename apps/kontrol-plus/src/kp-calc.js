// Після зміни розміру мапи (розкладка розрахунку рейсу) просимо Google Maps перемалюватись: window resize його підхоплює.
// Лише Контроль+ (модуль підключає site-bridge.js).
export function watchCalcMap(doc = document, win = window) {
    if (!win.ResizeObserver) return null;
    let raf = 0;
    const ro = new win.ResizeObserver(() => {
        win.cancelAnimationFrame(raf);
        raf = win.requestAnimationFrame(() => win.dispatchEvent(new win.Event('resize')));
    });
    const attach = () => {
        const frame = doc.querySelector('#studio-right > .tc-map-frame');
        if (frame && !frame.dataset.kpcWatched) { frame.dataset.kpcWatched = '1'; ro.observe(frame); }
        return Boolean(frame);
    };
    if (!attach()) {
        const mo = new win.MutationObserver(() => { if (attach()) mo.disconnect(); });
        mo.observe(doc.body, { childList: true, subtree: true });
    }
    return ro;
}
