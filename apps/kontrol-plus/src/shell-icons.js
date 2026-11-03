// Іконки бокового меню каркаса: inline SVG 16px (stroke = currentColor). Ті, що вже є в nav-icons.js, беруться звідти.
import { h, svgEl } from './ui.js';
import { NAV_ICON_NAMES, navIcon } from './nav-icons.js';

const EXTRA = {
    dashboard: [['rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }], ['path', { d: 'M5 10.5 7 8l2 1.5 2-3' }]],
    registry: [['rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }], ['path', { d: 'M2 6h12M2 9.5h12M6 6v7.5' }]],
    history: [['circle', { cx: 8, cy: 8, r: 5.8 }], ['path', { d: 'M8 4.8V8l2.3 1.4' }]],
    contracts: [['path', { d: 'M3.5 1.5h6L12.5 4.5v10h-9z' }], ['path', { d: 'M9.5 1.5v3h3M5.5 8.5h5M5.5 11h3' }]],
    invoices: [['rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }], ['path', { d: 'M2 6.5h12M5 10h2.5' }]],
    acts: [['path', { d: 'M3.5 1.5h9v13h-9z' }], ['path', { d: 'M6 5.5h4M6 8h4M6 10.5l1.2 1.2L10 9' }]],
    ttn: [['path', { d: 'M1.5 4h8v6.5h-8zM9.5 6.5h3l2 2.2v1.8h-5' }], ['path', { d: 'M3.5 6.5h4' }]],
    trip_sheets: [['rect', { x: 3, y: 1.5, width: 10, height: 13, rx: 1.5 }], ['path', { d: 'M5.5 5h5M5.5 8h5M5.5 11h3' }]],
    team: [['circle', { cx: 5.5, cy: 5.5, r: 2.2 }], ['circle', { cx: 11, cy: 6.5, r: 1.8 }], ['path', { d: 'M1.5 13.5c.3-2.4 1.9-3.6 4-3.6s3.7 1.2 4 3.6M10 10.3c2 0 3.8 1 4.2 3.2' }]],
    settings: [['circle', { cx: 8, cy: 8, r: 2.2 }], ['path', { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4' }]],
    bell: [['path', { d: 'M3.5 11.5h9L11.2 9.8V6.6a3.2 3.2 0 0 0-6.4 0v3.2zM6.6 13.5a1.5 1.5 0 0 0 2.8 0' }]],
    search: [['circle', { cx: 7, cy: 7, r: 4.3 }], ['path', { d: 'm10.3 10.3 3.2 3.2' }]],
    burger: [['path', { d: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11' }]],
    collapse: [['path', { d: 'M9.5 3.5 5 8l4.5 4.5M12.5 3v10' }]],
};

export const SHELL_ICON_NAMES = [...new Set([...NAV_ICON_NAMES, ...Object.keys(EXTRA)])];

export function shellIcon(name) {
    const shapes = EXTRA[name];
    if (!shapes) return navIcon(name);
    return h('span', { class: 'ic', 'aria-hidden': 'true' },
        svgEl('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
            shapes.map(([tag, attrs]) => svgEl(tag, attrs))));
}
