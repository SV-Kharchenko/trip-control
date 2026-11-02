// Генерує assets/brand/og-1200x630.png (Open Graph / Twitter large card): лого-маршрут і назва на темному тлі.
// Без зовнішніх залежностей для растеризації: контури гліфів Noto Sans беремо через fontkit (залежність Контроль+), заливаємо власним
// скан-лайном із супердискретизацією 3×3, PNG пишемо через zlib.
//   cd apps/kontrol-plus && npm ci && cd ../.. && node scripts/gen-og-image.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/kontrol-plus/package.json', import.meta.url));
const fontkit = require('@pdf-lib/fontkit');

const W = 1200;
const H = 630;
const S = 3;
const font = (name) => fontkit.create(fs.readFileSync(new URL('../apps/kontrol-plus/public/fonts/' + name, import.meta.url)));
const bold = font('NotoSans-Bold.ttf');
const regular = font('NotoSans-Regular.ttf');

// Шари: кожен — маска покриття S× і колір; малюємо по черзі зверху на RGB-буфер.
const rgb = new Float32Array(W * H * 3);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function fillBackground() {
    const a = hex('#0a0a0a');
    const b = hex('#10231f');
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const t = Math.min(1, Math.max(0, (x / W) * 0.55 + (y / H) * 0.45));
            for (let c = 0; c < 3; c += 1) rgb[(y * W + x) * 3 + c] = a[c] + (b[c] - a[c]) * t;
        }
    }
}

function flatten(commands, scale, ox, oy) {
    const polys = [];
    let cur = [];
    let x = 0;
    let y = 0;
    const P = (px, py) => [ox + px * scale, oy - py * scale];
    for (const { command, args } of commands) {
        if (command === 'moveTo') { if (cur.length) polys.push(cur); cur = [P(args[0], args[1])]; [x, y] = args; }
        else if (command === 'lineTo') { cur.push(P(args[0], args[1])); [x, y] = args; }
        else if (command === 'quadraticCurveTo') {
            for (let i = 1; i <= 8; i += 1) {
                const t = i / 8;
                cur.push(P((1 - t) ** 2 * x + 2 * (1 - t) * t * args[0] + t * t * args[2], (1 - t) ** 2 * y + 2 * (1 - t) * t * args[1] + t * t * args[3]));
            }
            [x, y] = [args[2], args[3]];
        } else if (command === 'bezierCurveTo') {
            for (let i = 1; i <= 10; i += 1) {
                const t = i / 10;
                const u = 1 - t;
                cur.push(P(u ** 3 * x + 3 * u * u * t * args[0] + 3 * u * t * t * args[2] + t ** 3 * args[4], u ** 3 * y + 3 * u * u * t * args[1] + 3 * u * t * t * args[3] + t ** 3 * args[5]));
            }
            [x, y] = [args[4], args[5]];
        } else if (command === 'closePath') { if (cur.length) polys.push(cur); cur = []; }
    }
    if (cur.length) polys.push(cur);
    return polys;
}

// Заливка набору полігонів (non-zero) кольором із прозорістю.
function paint(polys, color, alpha = 1) {
    const mask = new Uint8Array(W * S * H * S);
    for (let sy = 0; sy < H * S; sy += 1) {
        const yy = (sy + 0.5) / S;
        const hits = [];
        for (const poly of polys) {
            for (let i = 0; i < poly.length; i += 1) {
                const [x1, y1] = poly[i];
                const [x2, y2] = poly[(i + 1) % poly.length];
                if ((y1 <= yy && y2 > yy) || (y2 <= yy && y1 > yy)) hits.push([x1 + ((yy - y1) / (y2 - y1)) * (x2 - x1), y2 > y1 ? 1 : -1]);
            }
        }
        hits.sort((a, b) => a[0] - b[0]);
        let wind = 0;
        for (let i = 0; i < hits.length - 1; i += 1) {
            wind += hits[i][1];
            if (wind !== 0) {
                const from = Math.max(0, Math.round(hits[i][0] * S));
                const to = Math.min(W * S, Math.round(hits[i + 1][0] * S));
                for (let sx = from; sx < to; sx += 1) mask[sy * W * S + sx] = 1;
            }
        }
    }
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            let n = 0;
            for (let j = 0; j < S; j += 1) for (let i = 0; i < S; i += 1) n += mask[(y * S + j) * W * S + x * S + i];
            if (!n) continue;
            const a = (n / (S * S)) * alpha;
            for (let c = 0; c < 3; c += 1) rgb[(y * W + x) * 3 + c] += (color[c] - rgb[(y * W + x) * 3 + c]) * a;
        }
    }
}

const circle = (cx, cy, r) => [Array.from({ length: 48 }, (_, i) => [cx + r * Math.cos((i / 48) * 2 * Math.PI), cy + r * Math.sin((i / 48) * 2 * Math.PI)])];
// Товста лінія вздовж ламаної як об'єднання прямокутників-сегментів.
function stroke(points, width) {
    const polys = [];
    for (let i = 0; i < points.length - 1; i += 1) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[i + 1];
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const nx = (-(y2 - y1) / len) * (width / 2);
        const ny = ((x2 - x1) / len) * (width / 2);
        polys.push([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
        polys.push(...circle(x1, y1, width / 2));
    }
    polys.push(...circle(...points[points.length - 1], width / 2));
    return polys;
}
const bez = (p0, p1, p2, p3, n = 40) => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [0, 1].map((k) => u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k]);
});

function text(f, str, x, baseline, size, spacing, color) {
    const scale = size / f.unitsPerEm;
    const run = f.layout(str);
    let pen = x;
    run.glyphs.forEach((g, i) => {
        paint(flatten(g.path.commands, scale, pen, baseline), color);
        pen += run.positions[i].xAdvance * scale + spacing;
    });
    return pen - spacing - x;
}
const textWidth = (f, str, size, spacing) => f.layout(str).positions.reduce((s, p) => s + p.xAdvance * (size / f.unitsPerEm) + spacing, -spacing);

fillBackground();
// Логотип-маршрут (той самий мотив, що в assets/brand/logo-dark.svg), крупно ліворуч.
const tr = ([x, y]) => [x * 0.6 + 420, y * 0.6 - 30];
const route = bez([150, 470], [330, 470], [270, 300], [430, 300]).concat(bez([430, 300], [560, 300], [540, 170], [650, 140])).map(tr);
const [startX, startY] = tr([150, 470]);
const [endX, endY] = tr([650, 140]);
paint(stroke(route, 18), hex('#f2ede4'));
paint(stroke(route, 4), hex('#0a0a0a'), 0.8);
paint(circle(startX, startY, 22), hex('#d8c3a0'));
paint(circle(endX, endY, 28), hex('#f2ede4'));
paint(circle(endX, endY, 19), hex('#0a0a0a'));
paint(circle(endX, endY, 8), hex('#d8c3a0'));
// Назва й підпис.
const title = 'TRIP-CONTROL';
const tw = textWidth(bold, title, 92, 10);
text(bold, title, (W - tw) / 2, 330 + 120, 92, 10, hex('#f2ede4'));
const sub = 'Калькулятор прибутковості вантажних рейсів';
const sw = textWidth(regular, sub, 36, 1);
text(regular, sub, (W - sw) / 2, 330 + 120 + 70, 36, 1, hex('#d8c3a0'));
const url = 'trip-control.com';
const uw = textWidth(regular, url, 30, 2);
text(regular, url, (W - uw) / 2, H - 46, 30, 2, hex('#8f9a96'));

// ---- PNG ----
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W * 3; x += 1) raw[y * (W * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(rgb[y * W * 3 + x])));
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(new URL('../assets/brand/og-1200x630.png', import.meta.url), png);
console.log('og-1200x630.png', png.length, 'bytes');
