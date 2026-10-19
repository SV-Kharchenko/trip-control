import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { USER_BLOCKED_ERROR, userIsBlocked } from '../lib/account-block.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Основне дзеркало — overpass-api.de. kumi і private.coffee на довгому таймауті мовчать.
// Друга спроба лише після 429, 504 або обриву мережі, і лише якщо в бюджеті лишилось щонайменше 30 с.
export const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_MIRRORS = [OVERPASS_PRIMARY];
export const OVERPASS_USER_AGENT = 'trip-control.com (support@trip-control.com)';
export const OVERPASS_ATTEMPT_LIMIT = 2;
export const OVERPASS_TIMEOUT_MS = 27000;
export const POI_HANDLER_BUDGET_MS = 60000;
export const POI_ATTEMPT_RESERVE_MS = 30000;
export const CORRIDOR_CHUNK_METERS = 60000;
export const POI_SEGMENTS_PER_CALL = 2;
export const POI_SAMPLE_METERS = 5000;
export const POI_CALL_GAP_MS = 500;

export const config = { maxDuration: 60 };

export const POI_POINTS_LIMIT = 40;
export const POI_CORRIDOR_BUFFER_M = 3000;
export const POI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const POI_ERROR_TEXT = {
    OVERPASS_TIMEOUT: 'Сервіс карт не встиг відповісти',
    OVERPASS_RATE_LIMIT: 'Сервіс карт перевантажений, спробуй за хвилину',
    OVERPASS_UNAVAILABLE: 'Сервіс карт тимчасово недоступний',
    NETWORK: 'Помилка мережі'
};
const GEOHASH_BASE = '0123456789bcdefghjkmnpqrstuvwxyz';

export function poiPointsWithinLimit(count) {
    return Number.isInteger(count) && count > 0 && count <= POI_POINTS_LIMIT;
}

export function geohashEncode(lat, lon, precision = 5) {
    let idx = 0;
    let bit = 0;
    let even = true;
    let hash = '';
    let latMin = -90;
    let latMax = 90;
    let lonMin = -180;
    let lonMax = 180;
    while (hash.length < precision) {
        if (even) {
            const mid = (lonMin + lonMax) / 2;
            if (lon >= mid) {
                idx = idx * 2 + 1;
                lonMin = mid;
            } else {
                idx = idx * 2;
                lonMax = mid;
            }
        } else {
            const mid = (latMin + latMax) / 2;
            if (lat >= mid) {
                idx = idx * 2 + 1;
                latMin = mid;
            } else {
                idx = idx * 2;
                latMax = mid;
            }
        }
        even = !even;
        if (++bit === 5) {
            hash += GEOHASH_BASE[idx];
            bit = 0;
            idx = 0;
        }
    }
    return hash;
}

export function corridorSegmentKeys(points, precision = 5) {
    const keys = [];
    const seen = new Set();
    for (const point of points) {
        const key = geohashEncode(point.lat, point.lon, precision);
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

export function poiCacheFresh(fetchedAt, nowMs, ttlMs = POI_CACHE_TTL_MS) {
    const fetched = new Date(fetchedAt).getTime();
    if (!Number.isFinite(fetched) || !Number.isFinite(nowMs)) return false;
    return nowMs - fetched <= ttlMs;
}

export function selectedPoiTypes(body) {
    const types = [];
    if (body && body.wantGas) types.push('gas');
    if (body && body.wantTir) types.push('tir');
    if (body && body.wantCafe) types.push('cafe');
    if (body && body.wantSto) types.push('sto');
    return types;
}

export function corridorAroundClause(points, bufferMeters) {
    const coords = points.map(point => point.lat + ',' + point.lon).join(',');
    return 'around:' + bufferMeters + ',' + coords;
}

export function haversineMeters(from, to) {
    const toRad = degrees => degrees * Math.PI / 180;
    const dLat = toRad(to.lat - from.lat);
    const dLon = toRad(to.lon - from.lon);
    const lat1 = toRad(from.lat);
    const lat2 = toRad(to.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function corridorChunks(points, maxSpanMeters = CORRIDOR_CHUNK_METERS) {
    if (!points.length) return [];
    if (points.length === 1) return [points.slice()];
    const chunks = [];
    let current = [points[0]];
    let run = 0;
    for (let i = 1; i < points.length; i++) {
        const step = haversineMeters(points[i - 1], points[i]);
        if (current.length > 1 && run >= maxSpanMeters) {
            chunks.push(current);
            current = [points[i - 1]];
            run = 0;
        }
        current.push(points[i]);
        run += step;
    }
    chunks.push(current);
    return chunks;
}

export function overpassCorridorQuery(points, types, bufferMeters = POI_CORRIDOR_BUFFER_M) {
    const around = corridorAroundClause(points, bufferMeters);
    const lines = [];
    if (types.includes('gas')) lines.push('nw["amenity"="fuel"](' + around + ');');
    if (types.includes('cafe')) lines.push('nw["amenity"="cafe"](' + around + ');');
    if (types.includes('sto')) lines.push('nw["shop"="car_repair"](' + around + ');');
    if (types.includes('tir')) {
        lines.push('nw["amenity"="parking"]["hgv"](' + around + ');');
        lines.push('nw["highway"="rest_area"](' + around + ');');
    }
    // 32 МБ Overpass обриває на коридорі ~60 км («need at least 32 MB»). 64 МБ вже повертає об’єкти.
    return '[out:json][timeout:25][maxsize:67108864];(' + lines.join('') + ');out center;';
}

export function poiKind(tags) {
    const value = tags || {};
    if (value.amenity === 'fuel') return 'gas';
    if (value.amenity === 'cafe') return 'cafe';
    if (value.shop === 'car_repair') return 'sto';
    if (value.highway === 'rest_area') return 'tir';
    if (value.amenity === 'parking' && value.hgv) return 'tir';
    return null;
}

export function elementLatLon(element) {
    if (!element) return null;
    if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
        return { lat: element.lat, lon: element.lon };
    }
    if (element.center && Number.isFinite(element.center.lat) && Number.isFinite(element.center.lon)) {
        return { lat: element.center.lat, lon: element.center.lon };
    }
    return null;
}

export function normalizePoiElement(element) {
    const tags = element && element.tags ? element.tags : {};
    const kind = poiKind(tags);
    const pos = elementLatLon(element);
    if (!kind || !pos) return null;
    const name = tags.name || tags['name:uk'] || tags.brand || '';
    const address = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean).join(', ');
    return {
        id: String(element.type || 'n') + '/' + String(element.id),
        lat: pos.lat,
        lon: pos.lon,
        name: String(name),
        address: address,
        kind: kind
    };
}

export function roundPoiCoord(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(number * 100) / 100;
}

export function poiRouteCacheKey(points, types) {
    const coords = points.map(point => {
        const lat = roundPoiCoord(point.lat);
        const lon = roundPoiCoord(point.lon);
        return lat.toFixed(2) + ',' + lon.toFixed(2);
    }).join(';');
    const categories = [...types].sort().join(',');
    return createHash('sha256').update(coords + '|' + categories).digest('hex').slice(0, 12);
}

export function poiCanStart(startedAt, nowMs, budgetMs = POI_HANDLER_BUDGET_MS, reserveMs = POI_ATTEMPT_RESERVE_MS) {
    if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return false;
    return budgetMs - (nowMs - startedAt) >= reserveMs;
}

export function classifyOverpassFailure({ status = 0, network = false, mirror = OVERPASS_PRIMARY, ms = 0 }) {
    const timedOut = status === 504 || network === 'timeout';
    const rateLimited = status === 429;
    const code = timedOut ? 'OVERPASS_TIMEOUT' : (rateLimited ? 'OVERPASS_RATE_LIMIT' : 'OVERPASS_UNAVAILABLE');
    const http = code === 'OVERPASS_TIMEOUT' ? 504 : (code === 'OVERPASS_RATE_LIMIT' ? 429 : 502);
    return {
        error: true,
        code: code,
        status: http,
        network: network,
        detail: {
            mirror: mirror,
            status: status || 0,
            ms: ms
        }
    };
}

export function overpassRetryable(failure) {
    if (!failure) return false;
    if (failure.network) return true;
    const status = failure.detail && failure.detail.status;
    return status === 429 || status === 504;
}

export function nearestSegmentKey(item, points) {
    let best = points[0];
    let bestDistance = Infinity;
    for (const point of points) {
        const distance = (point.lat - item.lat) ** 2 + (point.lon - item.lon) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = point;
        }
    }
    return geohashEncode(best.lat, best.lon, 5);
}

export async function collectCorridorSegments(chunks, options) {
    const startedAt = options.startedAt;
    const now = options.now || Date.now;
    const load = options.load;
    const done = [];
    const failed = [];
    const pending = [];
    for (let index = 0; index < chunks.length; index++) {
        if (!poiCanStart(startedAt, now(), options.budgetMs, options.reserveMs)) {
            for (let rest = index; rest < chunks.length; rest++) pending.push(rest);
            break;
        }
        const result = await load(chunks[index], index);
        if (result && result.skipped) {
            for (let rest = index; rest < chunks.length; rest++) pending.push(rest);
            break;
        }
        if (result && result.error) {
            failed.push({
                index: index,
                code: result.code,
                detail: result.detail
            });
            continue;
        }
        done.push({
            index: index,
            elements: result && Array.isArray(result.elements) ? result.elements : [],
            cached: Boolean(result && result.cached)
        });
    }
    return { done: done, failed: failed, pending: pending };
}

export function poiJobsFromSegments(segmentInputs) {
    const jobs = [];
    let totalPoints = 0;
    const inputs = Array.isArray(segmentInputs) ? segmentInputs : [];
    inputs.forEach((raw, sourceIndex) => {
        const points = cleanPoints(raw);
        totalPoints += points.length;
        if (!points.length) return;
        for (const piece of corridorChunks(points)) {
            jobs.push({ index: sourceIndex, points: piece });
        }
    });
    return { jobs: jobs, totalPoints: totalPoints };
}

export function alignPoiIndexes(collected, sourceIndexes) {
    const indexes = sourceIndexes || [];
    return {
        done: (collected.done || []).map(part => Object.assign({}, part, {
            index: indexes[part.index]
        })),
        failed: (collected.failed || []).map(item => Object.assign({}, item, {
            index: indexes[item.index]
        })),
        pending: (collected.pending || []).map(index => indexes[index])
    };
}

export function poiResultPayload(collected) {
    const elements = [];
    const seen = new Set();
    for (const part of collected.done) {
        for (const item of part.elements) {
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);
            elements.push(item);
        }
    }
    const cached = collected.done.length > 0 && collected.done.every(part => part.cached) && collected.failed.length === 0 && collected.pending.length === 0;
    return {
        elements: elements,
        cached: cached,
        failed: collected.failed,
        pending: collected.pending
    };
}

function cleanPoints(rawPoints) {
    const points = [];
    const list = Array.isArray(rawPoints) ? rawPoints : [];
    for (const point of list) {
        const lat = parseFloat(point && point.lat);
        const lon = parseFloat(point && (point.lon != null ? point.lon : point.lng));
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            points.push({ lat: lat, lon: lon });
        }
    }
    return points;
}

async function readPoiCache(types, segmentKeys) {
    if (!segmentKeys.length) return [];
    const { data, error } = await supabase
        .from('poi_cache')
        .select('poi_type, segment_key, payload, fetched_at')
        .in('poi_type', types)
        .in('segment_key', segmentKeys);
    if (error) {
        console.warn('poi_cache read:', error.message);
        return null;
    }
    return data || [];
}

async function writePoiCache(rows) {
    if (!rows.length) return;
    const { error } = await supabase
        .from('poi_cache')
        .upsert(rows, { onConflict: 'poi_type,segment_key' });
    if (error) console.warn('poi_cache write:', error.message);
}

export async function fetchOverpass(query, options = {}) {
    const mirror = options.mirror || OVERPASS_PRIMARY;
    const fetchImpl = options.fetchImpl || fetch;
    const now = options.now || Date.now;
    const startedAt = options.startedAt == null ? now() : options.startedAt;
    const budgetMs = options.budgetMs == null ? POI_HANDLER_BUDGET_MS : options.budgetMs;
    const reserveMs = options.reserveMs == null ? POI_ATTEMPT_RESERVE_MS : options.reserveMs;
    const timeoutMs = options.timeoutMs == null ? OVERPASS_TIMEOUT_MS : options.timeoutMs;
    const attemptLimit = options.attemptLimit == null ? OVERPASS_ATTEMPT_LIMIT : options.attemptLimit;
    let last = null;

    for (let attempt = 0; attempt < attemptLimit; attempt++) {
        if (attempt > 0 && !overpassRetryable(last)) break;
        if (!poiCanStart(startedAt, now(), budgetMs, reserveMs)) {
            if (last) return last;
            return {
                error: true,
                skipped: true,
                code: 'OVERPASS_TIMEOUT',
                status: 504,
                detail: { mirror: mirror, status: 0, ms: 0 }
            };
        }
        const began = now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let status = 0;
        let network = false;
        try {
            const overpassRes = await fetchImpl(mirror, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                    'User-Agent': OVERPASS_USER_AGENT
                },
                body: 'data=' + encodeURIComponent(query),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            status = overpassRes.status;
            if (overpassRes.ok) {
                const data = await overpassRes.json();
                const elements = Array.isArray(data.elements) ? data.elements : [];
                const remark = String((data && (data.remark || data.error)) || '');
                if (!elements.length && /timed out|timeout|rate_limited/i.test(remark)) {
                    status = 504;
                } else if (!elements.length && /runtime error|out of memory|memory/i.test(remark)) {
                    status = 500;
                } else {
                    return {
                        elements: elements,
                        detail: { mirror: mirror, status: overpassRes.status, ms: Math.max(0, now() - began) }
                    };
                }
            }
        } catch (error) {
            clearTimeout(timeoutId);
            network = error && error.name === 'AbortError' ? 'timeout' : true;
            status = network === 'timeout' ? 504 : 0;
        }
        last = classifyOverpassFailure({
            status: status,
            network: network,
            mirror: mirror,
            ms: Math.max(0, now() - began)
        });
    }
    return last;
}

function cachedItemsFor(fresh, types, cacheKey) {
    const items = [];
    const seen = new Set();
    for (const type of types) {
        const payload = fresh.get(type + '|' + cacheKey);
        if (!Array.isArray(payload)) continue;
        for (const item of payload) {
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
        }
    }
    return items;
}

function storeChunk(fresh, types, cacheKey, elements) {
    const buckets = new Map();
    for (const type of types) buckets.set(type, []);
    for (const element of elements) {
        const item = normalizePoiElement(element);
        if (!item || !buckets.has(item.kind)) continue;
        const bucket = buckets.get(item.kind);
        if (bucket.some(existing => existing.id === item.id)) continue;
        bucket.push(item);
    }
    const fetchedAt = new Date().toISOString();
    const rows = [];
    const stored = [];
    for (const [type, payload] of buckets) {
        rows.push({
            poi_type: type,
            segment_key: cacheKey,
            payload: payload,
            fetched_at: fetchedAt
        });
        fresh.set(type + '|' + cacheKey, payload);
        stored.push(...payload);
    }
    return { rows: rows, elements: stored };
}

// ===== Адреси й відстань за OpenStreetMap (лендинг і демо-акаунти) =====
// GET /api/poi?mode=geocode&q=…  → підказки адрес (Photon);
// GET /api/poi?mode=route&from=lat,lon&to=lat,lon[&base=lat,lon] → км за дорогами (OSRM, профіль легкового авто — оцінка).
// Анонімні (лендинг без входу), без POI й без Overpass. Захист: per-IP ліміт у пам'яті інстансу (м'який, скидається
// на холодному старті) + CDN-кеш Vercel за URL. Платні/схвалені акаунти й далі працюють з Google у браузері.
export const OSM_GEO_PHOTON = 'https://photon.komoot.io/api/';
export const OSM_GEO_OSRM = 'https://router.project-osrm.org/route/v1/driving/';
export const OSM_GEO_REFERER = 'https://trip-control.com/';
export const OSM_GEO_TIMEOUT_MS = 7000;
export const OSM_GEO_MODES = ['geocode', 'route'];
export const OSM_GEO_RATE_LIMITS = { geocode: 60, route: 20 };
export const OSM_GEO_RATE_WINDOW_MS = 60 * 1000;
export const OSM_GEO_RATE_MAX_KEYS = 5000;
export const OSM_GEO_CACHE_CONTROL = {
    geocode: 'public, s-maxage=604800',
    route: 'public, s-maxage=86400, stale-while-revalidate=604800'
};
export const OSM_GEO_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_GEO_ERRORS = {
    GEO_BAD_INPUT: { status: 400, error: 'Некоректний запит адреси або координат.' },
    GEO_NO_ROUTE: { status: 404, error: 'Маршрут між цими точками не знайдено. Введіть відстань вручну.' },
    GEO_RATE_LIMIT: { status: 429, error: 'Забагато запитів. Спробуйте за хвилину або введіть відстань вручну.' },
    GEO_UNAVAILABLE: { status: 502, error: 'Сервіс карт тимчасово недоступний. Введіть відстань вручну.' },
    GEO_TIMEOUT: { status: 504, error: 'Сервіс карт не відповів вчасно. Введіть відстань вручну.' }
};
// Межі для координат: Європа з запасом (рейси з України в ЄС, Туреччину, Кавказ).
export const OSM_GEO_BOUNDS = { minLat: 34, maxLat: 72, minLon: -25, maxLon: 60 };
// Зсув підказок до центру України; результати з ЄС лишаються (bbox не ставимо, щоб не відрізати Європу).
export const OSM_GEO_BIAS = { lat: 49.0, lon: 31.5 };

const geoRateStore = new Map();

export function geoError(code) {
    const known = OSM_GEO_ERRORS[code] || OSM_GEO_ERRORS.GEO_UNAVAILABLE;
    return { status: known.status, body: { code: OSM_GEO_ERRORS[code] ? code : 'GEO_UNAVAILABLE', error: known.error } };
}

// q: trim + один пробіл + нижній регістр (той самий ключ CDN-кешу, що й на клієнті); 3–100 символів.
export function geoNormalizeQuery(value) {
    const q = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
    return q.length >= 3 && q.length <= 100 ? q : null;
}

// "lat,lon" → { lat, lon } з округленням до 4 знаків (~11 м); поза межами Європи → null.
export function geoParsePoint(value) {
    const parts = String(value == null ? '' : value).split(',');
    if (parts.length !== 2) return null;
    const raw = parts.map((part) => part.trim());
    if (raw.some((part) => !/^-?\d+(\.\d+)?$/.test(part))) return null;
    const lat = Math.round(Number(raw[0]) * 10000) / 10000;
    const lon = Math.round(Number(raw[1]) * 10000) / 10000;
    const b = OSM_GEO_BOUNDS;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
    if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) return null;
    return { lat, lon };
}

export function geoPhotonUrl(q) {
    return OSM_GEO_PHOTON + '?q=' + encodeURIComponent(q) + '&limit=6&lat=' + OSM_GEO_BIAS.lat.toFixed(1)
        + '&lon=' + OSM_GEO_BIAS.lon.toFixed(1);
}

export function geoOsrmUrl(from, to) {
    return OSM_GEO_OSRM + from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat
        + '?overview=false&alternatives=false&steps=false';
}

// Photon GeoJSON → [{ label, name, city, region, lat, lon }]; label = «Назва, місто/громада, область[, країна]».
export function geoNormalizePhoton(data) {
    const features = data && Array.isArray(data.features) ? data.features : [];
    const out = [];
    const seen = new Set();
    for (const feature of features) {
        const props = (feature && feature.properties) || {};
        const coords = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
            ? feature.geometry.coordinates : [];
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        // Точки поза Європою відкидаємо: маршрут до них route однаково не прийме.
        const b = OSM_GEO_BOUNDS;
        if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
        const street = [props.street, props.housenumber].filter(Boolean).join(' ');
        const name = String(props.name || street || '').trim();
        if (!name) continue;
        const cityRaw = String(props.city || props.county || '').trim();
        const city = cityRaw && cityRaw !== name ? cityRaw : '';
        const region = String(props.state || '').trim();
        const country = props.countrycode && String(props.countrycode).toUpperCase() !== 'UA'
            ? String(props.country || '').trim() : '';
        const parts = [];
        for (const part of [name, city, region, country]) {
            if (part && !parts.includes(part)) parts.push(part);
        }
        const label = parts.join(', ');
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({
            label,
            name,
            city,
            region,
            lat: Math.round(lat * 1e6) / 1e6,
            lon: Math.round(lon * 1e6) / 1e6
        });
        if (out.length >= 6) break;
    }
    return out;
}

export function geoClientIp(req) {
    const headers = (req && req.headers) || {};
    const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
    const real = String(headers['x-real-ip'] || '').trim();
    return real || 'unknown';
}

// Фіксоване вікно на ключ (режим + IP). Пам'ять інстансу: м'який захист, не спільний між інстансами.
export function geoRateLimited(store, key, limit, nowMs, windowMs = OSM_GEO_RATE_WINDOW_MS, maxKeys = OSM_GEO_RATE_MAX_KEYS) {
    let entry = store.get(key);
    if (!entry || nowMs >= entry.resetAt) {
        entry = { count: 0, resetAt: nowMs + windowMs };
        store.delete(key);
        store.set(key, entry);
    }
    entry.count += 1;
    if (store.size > maxKeys) {
        for (const [k, v] of store) {
            if (nowMs >= v.resetAt) store.delete(k);
        }
        for (const k of store.keys()) {
            if (store.size <= maxKeys) break;
            if (k !== key) store.delete(k);
        }
    }
    return entry.count > limit;
}

export async function geoFetchJson(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const timeoutMs = options.timeoutMs == null ? OSM_GEO_TIMEOUT_MS : options.timeoutMs;
    const log = options.log || geoLogUpstream;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let result;
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': OVERPASS_USER_AGENT,
                'Referer': OSM_GEO_REFERER
            },
            signal: controller.signal
        });
        let data = null;
        try { data = await response.json(); } catch (e) { data = null; }
        result = { ok: response.ok, status: response.status, data };
    } catch (error) {
        result = { ok: false, status: 0, data: null, timeout: !!(error && error.name === 'AbortError') };
    } finally {
        clearTimeout(timeoutId);
    }
    log(geoUpstreamLogLine(url, result, Date.now() - startedAt));
    return result;
}

// Рядок у runtime-лог: лише сервіс, статус upstream і тривалість. Без IP, без адреси (q) і координат.
export function geoUpstreamLogLine(url, result, ms) {
    let host = 'unknown';
    try { host = new URL(url).hostname; } catch (e) { host = 'unknown'; }
    const status = result.timeout ? 'timeout' : (result.status || 'network');
    return 'osm-geo upstream ' + host + ' status=' + status + ' ms=' + Math.max(0, Math.round(ms));
}

function geoLogUpstream(line) {
    console.info(line);
}

function geoUpstreamError(result) {
    if (result.timeout) return geoError('GEO_TIMEOUT');
    if (result.status === 429) return geoError('GEO_RATE_LIMIT');
    return geoError('GEO_UNAVAILABLE');
}

export async function geoGeocode(rawQuery, options = {}) {
    const q = geoNormalizeQuery(rawQuery);
    if (!q) return geoError('GEO_BAD_INPUT');
    const result = await geoFetchJson(geoPhotonUrl(q), options);
    if (!result.ok) return geoUpstreamError(result);
    return { status: 200, body: { items: geoNormalizePhoton(result.data), source: 'photon', attribution: OSM_GEO_ATTRIBUTION } };
}

async function geoOsrmKm(from, to, options) {
    const result = await geoFetchJson(geoOsrmUrl(from, to), options);
    const code = result.data && result.data.code;
    if (code === 'NoRoute' || code === 'NoSegment') return { failure: geoError('GEO_NO_ROUTE') };
    if (!result.ok) return { failure: geoUpstreamError(result) };
    const route = code === 'Ok' && Array.isArray(result.data.routes) ? result.data.routes[0] : null;
    const meters = route ? Number(route.distance) : NaN;
    if (!Number.isFinite(meters)) return { failure: geoError('GEO_UNAVAILABLE') };
    return { km: Math.round(meters / 1000) };
}

export async function geoRoute(query, options = {}) {
    const from = geoParsePoint(query && query.from);
    const to = geoParsePoint(query && query.to);
    const hasBase = query && query.base != null && String(query.base).trim() !== '';
    const base = hasBase ? geoParsePoint(query.base) : null;
    if (!from || !to || (hasBase && !base)) return geoError('GEO_BAD_INPUT');
    const legs = [geoOsrmKm(from, to, options)];
    if (base) legs.push(geoOsrmKm(base, from, options));
    const [main, podacha] = await Promise.all(legs);
    if (main.failure) return main.failure;
    const body = { km: main.km };
    if (podacha && !podacha.failure) body.podacha_km = podacha.km;
    body.source = 'osrm';
    body.estimate = true;
    body.attribution = OSM_GEO_ATTRIBUTION;
    // Просили подачу, а плече base→A впало: відповідь неповна — CDN її не кешує.
    return { status: 200, body, cacheable: !(podacha && podacha.failure) };
}

// Спільний бюджет на інстанс для запитів до Photon / OSRM (≈1 запит/с, невеликий запас на route з подачею):
// поважаємо fair-use публічних сервісів незалежно від кількості IP. Відповіді з CDN сюди не доходять.
export const OSM_GEO_UPSTREAM_RPS = 1;
export const OSM_GEO_UPSTREAM_BURST = 2;
const geoUpstreamBudget = { tokens: OSM_GEO_UPSTREAM_BURST, at: 0 };

export function geoTakeBudget(state, cost, nowMs, rps = OSM_GEO_UPSTREAM_RPS, burst = OSM_GEO_UPSTREAM_BURST) {
    const elapsed = Math.max(0, nowMs - state.at) / 1000;
    state.tokens = Math.min(burst, state.tokens + elapsed * rps);
    state.at = nowMs;
    if (state.tokens < cost) return false;
    state.tokens -= cost;
    return true;
}

// Скільки запитів до Photon / OSRM потрібно (некоректний запит бюджет не витрачає).
export function geoUpstreamCost(mode, query) {
    const q = query || {};
    if (mode === 'geocode') return geoNormalizeQuery(q.q) ? 1 : 0;
    if (!geoParsePoint(q.from) || !geoParsePoint(q.to)) return 0;
    return q.base != null && String(q.base).trim() !== '' && geoParsePoint(q.base) ? 2 : 1;
}

function geoRequestQuery(req) {
    if (req && req.query && typeof req.query === 'object') return req.query;
    try {
        return Object.fromEntries(new URL((req && req.url) || '/', 'https://trip-control.com').searchParams);
    } catch (e) {
        return {};
    }
}

export function geoRequestMode(req) {
    if (!req || req.method !== 'GET') return null;
    const mode = geoRequestQuery(req).mode;
    return OSM_GEO_MODES.includes(mode) ? mode : null;
}

export async function handleGeo(req, res, options = {}) {
    const mode = geoRequestMode(req);
    const query = geoRequestQuery(req);
    const store = options.rateStore || geoRateStore;
    const budget = options.budget || geoUpstreamBudget;
    const now = options.now || Date.now;
    let result;
    try {
        const limit = OSM_GEO_RATE_LIMITS[mode];
        const cost = geoUpstreamCost(mode, query);
        if (geoRateLimited(store, mode + '|' + geoClientIp(req), limit, now())) {
            result = geoError('GEO_RATE_LIMIT');
        } else if (cost > 0 && !geoTakeBudget(budget, cost, now())) {
            result = geoError('GEO_RATE_LIMIT');
        } else if (mode === 'geocode') {
            result = await geoGeocode(query.q, options);
        } else {
            result = await geoRoute(query, options);
        }
    } catch (error) {
        console.warn('osm geo:', error && error.message);
        result = geoError('GEO_UNAVAILABLE');
    }
    const cacheable = result.status === 200 && result.cacheable !== false;
    res.setHeader('Cache-Control', cacheable ? OSM_GEO_CACHE_CONTROL[mode] : 'no-store');
    return res.status(result.status).json(result.body);
}

export default async function handler(req, res) {
    if (geoRequestMode(req)) {
        return handleGeo(req, res);
    }
    const startedAt = Date.now();
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Необхідна авторизація.' });
        }
        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: 'Недійсний токен.' });
        }
        if (userIsBlocked(user)) {
            return res.status(403).json(USER_BLOCKED_ERROR);
        }
        const { data: profile } = await supabase
            .from('profiles')
            .select('is_approved, member_status, organizations(status)')
            .eq('id', user.id)
            .single();
        if (profile?.member_status === 'disabled') {
            return res.status(403).json({ code: 'MEMBER_DISABLED', error: 'Доступ до компанії відключено.' });
        }
        if (!profile || !profile.is_approved) {
            return res.status(403).json({ error: 'Акаунт очікує підтвердження адміністратора.' });
        }
        if (profile.organizations && profile.organizations.status === 'blocked') {
            return res.status(403).json({ code: 'ORG_BLOCKED', error: 'Доступ компанії заблоковано адміністратором.' });
        }

        const body = req.body || {};
        const segmentInputs = Array.isArray(body.segments) && body.segments.length
            ? body.segments
            : [Array.isArray(body.points) ? body.points : []];
        if (segmentInputs.length > POI_SEGMENTS_PER_CALL) {
            return res.status(400).json({ error: 'Забагато відрізків за один виклик. Максимум 2.' });
        }
        const planned = poiJobsFromSegments(segmentInputs);
        const totalPoints = planned.totalPoints;
        if (!totalPoints) {
            return res.status(400).json({ error: 'Не передано жодної точки маршруту.' });
        }
        if (!poiPointsWithinLimit(totalPoints)) {
            return res.status(400).json({
                code: 'POI_POINTS_LIMIT',
                error: 'Забагато точок маршруту. Максимум ' + POI_POINTS_LIMIT + '.'
            });
        }
        const types = selectedPoiTypes(body);
        if (!types.length) {
            return res.status(400).json({ error: 'Оберіть хоча б одну категорію.' });
        }

        const chunks = planned.jobs.map(job => job.points);
        const sourceIndexes = planned.jobs.map(job => job.index);
        const cacheKeys = chunks.map(chunk => poiRouteCacheKey(chunk, types));
        const cacheRows = await readPoiCache(types, cacheKeys);
        const fresh = new Map();
        if (cacheRows) {
            for (const row of cacheRows) {
                if (cacheKeys.includes(row.segment_key) && poiCacheFresh(row.fetched_at, Date.now())) {
                    fresh.set(row.poi_type + '|' + row.segment_key, row.payload);
                }
            }
        }

        const collected = await collectCorridorSegments(chunks, {
            startedAt: startedAt,
            load: async (chunk, index) => {
                const cacheKey = cacheKeys[index];
                const missingTypes = types.filter(type => !fresh.has(type + '|' + cacheKey));
                if (!missingTypes.length) {
                    return { elements: cachedItemsFor(fresh, types, cacheKey), cached: true };
                }
                const fetched = await fetchOverpass(overpassCorridorQuery(chunk, missingTypes), { startedAt: startedAt });
                if (fetched.skipped) return fetched;
                if (fetched.error) {
                    console.warn('poi overpass:', fetched.code, fetched.detail && fetched.detail.status, fetched.detail && fetched.detail.ms);
                    return fetched;
                }
                const stored = storeChunk(fresh, missingTypes, cacheKey, fetched.elements);
                await writePoiCache(stored.rows);
                const elements = cachedItemsFor(fresh, types, cacheKey);
                return { elements: elements, cached: false };
            }
        });

        const payload = poiResultPayload(alignPoiIndexes(collected, sourceIndexes));
        if (!payload.elements.length && payload.failed.length) {
            const failure = payload.failed[0];
            return res.status(failure.code === 'OVERPASS_TIMEOUT' ? 504 : (failure.code === 'OVERPASS_RATE_LIMIT' ? 429 : 502)).json({
                code: failure.code,
                error: POI_ERROR_TEXT[failure.code] || POI_ERROR_TEXT.OVERPASS_UNAVAILABLE,
                detail: failure.detail,
                failed: payload.failed,
                pending: payload.pending,
                elements: []
            });
        }
        return res.status(200).json({
            elements: payload.elements,
            cached: payload.cached,
            failed: payload.failed,
            pending: payload.pending,
            attribution: '© OpenStreetMap contributors'
        });
    } catch (err) {
        console.error('POI proxy error:', err);
        return res.status(500).json({ error: 'Не вдалося знайти об’єкти вздовж маршруту.' });
    }
}
