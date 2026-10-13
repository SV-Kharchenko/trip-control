import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Один запит на маршрут. Якщо дзеркало відповідає 429 або 504, чекаємо і беремо наступне.
// Без свого User-Agent публічні сервери Overpass ріжуть запит як анонімний.
export const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
];
export const OVERPASS_USER_AGENT = 'trip-control.com (support@trip-control.com)';
export const OVERPASS_BACKOFF_MS = [1000, 3000];
export const OVERPASS_ATTEMPT_LIMIT = 3;
export const POI_BUSY_MESSAGE = 'Сервіс карт перевантажений, спробуй за хвилину';
const OVERPASS_TIMEOUT_MS = 9000;

export const POI_POINTS_LIMIT = 25;
export const POI_CORRIDOR_BUFFER_M = 4000;
export const POI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

export function overpassCorridorQuery(points, types, bufferMeters = POI_CORRIDOR_BUFFER_M) {
    const around = corridorAroundClause(points, bufferMeters);
    const lines = [];
    if (types.includes('gas')) lines.push('nwr["amenity"="fuel"](' + around + ');');
    if (types.includes('cafe')) lines.push('nwr["amenity"="cafe"](' + around + ');');
    if (types.includes('sto')) lines.push('nwr["shop"="car_repair"](' + around + ');');
    if (types.includes('tir')) {
        lines.push('nwr["amenity"="parking"]["hgv"](' + around + ');');
        lines.push('nwr["highway"="rest_area"](' + around + ');');
    }
    return '[out:json][timeout:8];(' + lines.join('') + ');out center 200;';
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

export function isOverpassBackoffStatus(status) {
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

function cleanPoints(rawPoints) {
    const points = [];
    for (const point of rawPoints) {
        const lat = parseFloat(point && point.lat);
        const lon = parseFloat(point && (point.lon != null ? point.lon : point.lng));
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            points.push({ lat: lat, lon: lon });
        }
    }
    return points;
}

async function readPoiCache(types, segmentKeys) {
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
    const mirrors = options.mirrors || OVERPASS_MIRRORS;
    const fetchImpl = options.fetchImpl || fetch;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const backoffMs = options.backoffMs || OVERPASS_BACKOFF_MS;
    const attemptLimit = options.attemptLimit || OVERPASS_ATTEMPT_LIMIT;
    const timeoutMs = options.timeoutMs == null ? OVERPASS_TIMEOUT_MS : options.timeoutMs;
    const attempts = Math.min(attemptLimit, mirrors.length);
    let lastStatus = 0;
    let lastDetail = 'невідома помилка';

    for (let i = 0; i < attempts; i++) {
        const mirror = mirrors[i];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let status = 0;
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
                return { elements: Array.isArray(data.elements) ? data.elements : [] };
            }
            lastStatus = status;
            lastDetail = 'HTTP ' + status;
        } catch (error) {
            clearTimeout(timeoutId);
            lastDetail = error && error.name === 'AbortError' ? 'timeout' : ((error && error.message) || 'network');
        }
        if (i < attempts - 1 && isOverpassBackoffStatus(status)) {
            await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
        }
    }
    return { error: 'overpass_busy', status: lastStatus, detail: lastDetail };
}

function cachedItems(fresh, types) {
    const items = [];
    const seen = new Set();
    for (const [key, payload] of fresh) {
        const type = key.split('|')[0];
        if (!types.includes(type) || !Array.isArray(payload)) continue;
        for (const item of payload) {
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
        }
    }
    return items;
}

export default async function handler(req, res) {
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
        const rawPoints = Array.isArray(body.points) ? body.points : [];
        if (rawPoints.length === 0) {
            return res.status(400).json({ error: 'Не передано жодної точки маршруту.' });
        }
        if (!poiPointsWithinLimit(rawPoints.length)) {
            return res.status(400).json({
                code: 'POI_POINTS_LIMIT',
                error: 'Забагато точок маршруту. Максимум 25.'
            });
        }
        const points = cleanPoints(rawPoints);
        if (!points.length) {
            return res.status(400).json({ error: 'Точки маршруту некоректні.' });
        }
        const types = selectedPoiTypes(body);
        if (!types.length) {
            return res.status(400).json({ error: 'Оберіть хоча б одну категорію.' });
        }

        const cacheKey = poiRouteCacheKey(points, types);
        const nowMs = Date.now();
        const cacheRows = await readPoiCache(types, [cacheKey]);
        const fresh = new Map();
        if (cacheRows) {
            for (const row of cacheRows) {
                if (row.segment_key === cacheKey && poiCacheFresh(row.fetched_at, nowMs)) {
                    fresh.set(row.poi_type + '|' + row.segment_key, row.payload);
                }
            }
        }
        const missingTypes = types.filter(type => !fresh.has(type + '|' + cacheKey));
        if (!missingTypes.length) {
            return res.status(200).json({
                elements: cachedItems(fresh, types),
                cached: true,
                attribution: '© OpenStreetMap contributors'
            });
        }

        const fetched = await fetchOverpass(overpassCorridorQuery(points, missingTypes));
        if (fetched.error) {
            console.warn('poi overpass:', fetched.status || '', fetched.detail || '');
            const saved = cachedItems(fresh, types);
            if (saved.length) {
                return res.status(200).json({
                    elements: saved,
                    cached: true,
                    warning: 'Сервіс карт перевантажений. Показано збережені об’єкти.',
                    attribution: '© OpenStreetMap contributors'
                });
            }
            return res.status(503).json({ code: 'OVERPASS_BUSY', error: POI_BUSY_MESSAGE });
        }

        const buckets = new Map();
        for (const type of missingTypes) buckets.set(type, []);
        for (const element of fetched.elements) {
            const item = normalizePoiElement(element);
            if (!item || !buckets.has(item.kind)) continue;
            const bucket = buckets.get(item.kind);
            if (bucket.some(existing => existing.id === item.id)) continue;
            bucket.push(item);
        }
        const fetchedAt = new Date(nowMs).toISOString();
        const rows = [];
        for (const [type, payload] of buckets) {
            const key = type + '|' + cacheKey;
            rows.push({
                poi_type: type,
                segment_key: cacheKey,
                payload: payload,
                fetched_at: fetchedAt
            });
            fresh.set(key, payload);
        }
        await writePoiCache(rows);

        return res.status(200).json({
            elements: cachedItems(fresh, types),
            cached: false,
            attribution: '© OpenStreetMap contributors'
        });
    } catch (err) {
        console.error('POI proxy error:', err);
        return res.status(500).json({ error: 'Не вдалося знайти об’єкти вздовж маршруту.' });
    }
}
