// Іконки лівого меню кабінету: inline SVG 16px (stroke = currentColor), нічого не залежить від шрифту.
import { h, svgEl } from './ui.js';

const ICONS = {
    overview: [['rect', { x: 2, y: 2, width: 5, height: 5, rx: 1 }], ['rect', { x: 9, y: 2, width: 5, height: 5, rx: 1 }], ['rect', { x: 2, y: 9, width: 5, height: 5, rx: 1 }], ['rect', { x: 9, y: 9, width: 5, height: 5, rx: 1 }]],
    calc: [['rect', { x: 3, y: 1.5, width: 10, height: 13, rx: 1.5 }], ['path', { d: 'M5.5 5h5M5.5 8.5h1M9.5 8.5h1M5.5 11.5h1M9.5 11.5h1' }]],
    clients: [['circle', { cx: 6, cy: 5.5, r: 2.4 }], ['path', { d: 'M1.5 14c.3-2.6 2.2-4 4.5-4s4.2 1.4 4.5 4' }], ['circle', { cx: 11.5, cy: 6, r: 1.8 }], ['path', { d: 'M11 10.2c2 .1 3.3 1.3 3.5 3.8' }]],
    fleet: [['path', { d: 'M1.5 4h8v6.5h-8zM9.5 6.5h3l2 2.2v1.8h-5' }], ['circle', { cx: 4.5, cy: 12, r: 1.4 }], ['circle', { cx: 11.5, cy: 12, r: 1.4 }]],
    drivers: [['circle', { cx: 8, cy: 5, r: 2.6 }], ['path', { d: 'M2.5 14c.4-3 2.6-4.5 5.5-4.5s5.1 1.5 5.5 4.5' }]],
    repairs: [['path', { d: 'M10.5 2.5a3.3 3.3 0 0 0-3 4.6L2.5 12.1a1.4 1.4 0 0 0 2 2l5-5a3.3 3.3 0 0 0 4.6-3l-2.2 2.2-1.9-.5-.5-1.9z' }]],
    gps: [['path', { d: 'M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 1 0-9 0c0 3.8 4.5 8 4.5 8z' }], ['circle', { cx: 8, cy: 6.5, r: 1.6 }]],
    docs: [['path', { d: 'M4 1.5h5.5L13 5v9.5H4z' }], ['path', { d: 'M9.5 1.5V5H13M6 8.5h5M6 11h5' }]],
    report: [['path', { d: 'M2 5h10.5M10 2.5 12.5 5 10 7.5M14 11H3.5M6 8.5 3.5 11 6 13.5' }]],
    stats: [['path', { d: 'M2 14h12' }], ['rect', { x: 3, y: 8, width: 2.4, height: 6, rx: 0.6 }], ['rect', { x: 6.8, y: 4.5, width: 2.4, height: 9.5, rx: 0.6 }], ['rect', { x: 10.6, y: 2, width: 2.4, height: 12, rx: 0.6 }]],
    company: [['path', { d: 'M2.5 14.5v-11l6-2v13M8.5 6.5l5 1.5v6.5M1.5 14.5h13' }], ['path', { d: 'M5 5.5h1.5M5 8h1.5M5 10.5h1.5' }]],
};

export const NAV_ICON_NAMES = Object.keys(ICONS);

export function navIcon(name) {
    const shapes = ICONS[name] || [];
    return h('span', { class: 'ic', 'aria-hidden': 'true' },
        svgEl('svg', { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
            shapes.map(([tag, attrs]) => svgEl(tag, attrs))));
}
