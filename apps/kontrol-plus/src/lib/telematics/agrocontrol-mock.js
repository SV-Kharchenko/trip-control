// Агроконтроль, тестові дані: детерміновані (одне й те саме для org_id + авто + дати), без мережі й без випадковості Math.random.
// Цифри реалістичні: трактор 40–120 км/день, 30–45 л/100 км; вантажівка 120–300 км/день, 25–38 л/100 км; простій 0–4 год; рідкі зливи 20–80 л.

// Хеш рядка → 32-бітне число (FNV-1a), потім mulberry32 — послідовність у [0, 1).
export function hashSeed(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function rng(seedText) {
    let a = hashSeed(seedText);
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const between = (r, min, max) => min + r * (max - min);
const round1 = (n) => String(Math.round(n * 10) / 10);

export function eachDate(from, to) {
    const out = [];
    const end = Date.parse(to + 'T00:00:00Z');
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= end && out.length < 400; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
}

// Трактор чи вантажівка — стабільно для пари (організація, авто).
export function vehicleProfile(orgId, label) {
    const truck = rng(orgId + '|kind|' + label)() < 0.5;
    return truck ? { type: 'truck', kmMin: 120, kmMax: 300, l100Min: 25, l100Max: 38 } : { type: 'tractor', kmMin: 40, kmMax: 120, l100Min: 30, l100Max: 45 };
}

export function createAgrocontrolMock(ctx) {
    const orgId = String((ctx && ctx.orgId) || '');
    const vehicles = (ctx && ctx.vehicles) || [];
    return {
        kind: 'agrocontrol_mock',
        async fetchReports({ from, to }) {
            const rows = [];
            for (const v of vehicles) {
                const p = vehicleProfile(orgId, v.label);
                for (const date of eachDate(from, to)) {
                    const r = rng(orgId + '|' + v.label + '|' + date);
                    if (r() < 0.12) continue; // день без виїзду
                    const km = between(r(), p.kmMin, p.kmMax);
                    const l100 = between(r(), p.l100Min, p.l100Max);
                    const idle = Math.round(r() * 240);
                    const hours = km / between(r(), 22, 38) + idle / 60;
                    rows.push({ date, ref: v.label, mileage_km: round1(km), fuel_used_l: round1((km * l100) / 100), idle_minutes: String(idle), engine_hours: round1(hours),
                        raw: { source: 'agrocontrol_mock' } });
                }
            }
            return rows;
        },
        async fetchFuelEvents({ from, to }) {
            const rows = [];
            for (const v of vehicles) {
                for (const date of eachDate(from, to)) {
                    const r = rng(orgId + '|ev|' + v.label + '|' + date);
                    if (r() < 0.3) {
                        const hh = String(Math.floor(between(r(), 5, 20))).padStart(2, '0');
                        rows.push({ ts: date + 'T' + hh + ':' + String(Math.floor(r() * 60)).padStart(2, '0') + ':00Z', ref: v.label, kind: 'refuel',
                            liters: round1(between(r(), 80, 350)), location: 'АЗС', raw: { source: 'agrocontrol_mock' } });
                    }
                    if (r() < 0.02) {
                        const hh = String(Math.floor(between(r(), 0, 24))).padStart(2, '0');
                        rows.push({ ts: date + 'T' + hh + ':' + String(Math.floor(r() * 60)).padStart(2, '0') + ':00Z', ref: v.label, kind: 'drain',
                            liters: round1(between(r(), 20, 80)), location: 'Поза маршрутом', raw: { source: 'agrocontrol_mock' } });
                    }
                }
            }
            return rows;
        },
    };
}
