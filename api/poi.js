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
        const points = Array.isArray(body.points) ? body.points : [];
        if (points.length === 0) {
            return res.status(400).json({ error: 'Не передано жодної точки маршруту.' });
        }
        const radius = Math.min(parseInt(body.radius) || 8000, 20000); // захист від надто широкого запиту

        // Один комбінований запит на ВСІ точки одразу, замість окремого запиту на кожну —
        // менше звернень до Overpass = менший ризик впертись у ліміт частоти (429).
        const filters = [];
        for (const pt of points) {
            const lat = parseFloat(pt.lat);
            const lon = parseFloat(pt.lon);
            if (isNaN(lat) || isNaN(lon)) continue;
            if (body.wantGas) filters.push(`nwr["amenity"="fuel"](around:${radius},${lat},${lon});`);
            if (body.wantCafe) filters.push(`nwr["amenity"="cafe"](around:${radius},${lat},${lon});`);
            if (body.wantSto) filters.push(`nwr["shop"="car_repair"](around:${radius},${lat},${lon});`);
            if (body.wantTir) {
                filters.push(`nwr["amenity"="parking"]["hgv"](around:${radius},${lat},${lon});`);
                filters.push(`nwr["highway"="rest_area"](around:${radius},${lat},${lon});`);
            }
        }

        if (filters.length === 0) {
            return res.status(200).json({ elements: [] });
        }

        // Overpass повертає об'єднання (union) без дублів навіть якщо кілька "around" збігаються,
        // тож ліміт виводу піднімаємо пропорційно кількості точок, а не лишаємо фіксовані 15 на все.
        const outLimit = Math.min(points.length * 20, 200);
        const query = `[out:json][timeout:8];(${filters.join('')});out center ${outLimit};`;

        let lastError = 'невідома помилка';
        for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
            const mirror = OVERPASS_MIRRORS[i];
            // Vercel Hobby вбиває функцію за 10с загалом — власний таймаут гарантує, що повільне
            // дзеркало не з'їсть увесь бюджет часу, лишивши нуль секунд на спробу другого.
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            try {
                const overpassRes = await fetch(mirror, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'data=' + encodeURIComponent(query),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (overpassRes.ok) {
                    const data = await overpassRes.json();
                    return res.status(200).json(data);
                }
                lastError = `${mirror} відповів HTTP ${overpassRes.status}`;
            } catch (e) {
                clearTimeout(timeoutId);
                lastError = e.name === 'AbortError' ? `${mirror}: перевищено таймаут (4с)` : `${mirror}: ${e.message}`;
            }
            // Невелика пауза перед спробою дзеркала — щоб не бити в той самий ліміт частоти миттєво повторно
            if (i < OVERPASS_MIRRORS.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Обидва дзеркала не відповіли — повертаємо реальну помилку, а не тиху "0 об'єктів"
        return res.status(502).json({ error: 'Overpass недоступний: ' + lastError });

    } catch (err) {
        console.error('POI proxy error:', err);
        return res.status(500).json({ error: err.message });
    }
}
