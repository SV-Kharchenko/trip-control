import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Основний сервер + резервне дзеркало — якщо перший недоступний/перевантажений (CORS сюди не
// стосується взагалі, бо це запит сервер-до-сервера, а не з браузера).
const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // --- Перевірка авторизації та схвалення акаунта (той самий патерн, що й /api/calculate) ---
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
            .select('is_approved')
            .eq('id', user.id)
            .single();
        if (!profile || !profile.is_approved) {
            return res.status(403).json({ error: 'Акаунт очікує підтвердження адміністратора.' });
        }

        const body = req.body || {};
        const lat = parseFloat(body.lat);
        const lon = parseFloat(body.lon);
        if (isNaN(lat) || isNaN(lon)) {
            return res.status(400).json({ error: 'Некоректні координати точки.' });
        }
        const radius = Math.min(parseInt(body.radius) || 8000, 20000); // захист від надто широкого запиту

        const filters = [];
        if (body.wantGas) filters.push(`nwr["amenity"="fuel"](around:${radius},${lat},${lon});`);
        if (body.wantCafe) filters.push(`nwr["amenity"="cafe"](around:${radius},${lat},${lon});`);
        if (body.wantSto) filters.push(`nwr["shop"="car_repair"](around:${radius},${lat},${lon});`);
        if (body.wantTir) {
            filters.push(`nwr["amenity"="parking"]["hgv"](around:${radius},${lat},${lon});`);
            filters.push(`nwr["highway"="rest_area"](around:${radius},${lat},${lon});`);
        }

        if (filters.length === 0) {
            return res.status(200).json({ elements: [] });
        }

        const query = `[out:json][timeout:25];(${filters.join('')});out center 15;`;

        let lastError = 'невідома помилка';
        for (const mirror of OVERPASS_MIRRORS) {
            try {
                const overpassRes = await fetch(mirror, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'data=' + encodeURIComponent(query)
                });
                if (overpassRes.ok) {
                    const data = await overpassRes.json();
                    return res.status(200).json(data);
                }
                lastError = `${mirror} відповів HTTP ${overpassRes.status}`;
            } catch (e) {
                lastError = `${mirror}: ${e.message}`;
            }
        }

        // Обидва дзеркала не відповіли — повертаємо реальну помилку, а не тиху "0 об'єктів"
        return res.status(502).json({ error: 'Overpass недоступний: ' + lastError });

    } catch (err) {
        console.error('POI proxy error:', err);
        return res.status(500).json({ error: err.message });
    }
}
