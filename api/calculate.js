import { createClient } from '@supabase/supabase-js';
import { calculateTrip } from './_lib/calc-core.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Скільки розрахунків на добу дозволено в демо-режимі (акаунт без схвалення адміністратором)
const DEMO_DAILY_LIMIT = 5;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // --- Перевірка авторизації та схвалення акаунта ---
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
            .select('is_approved, org_id, organizations(status)')
            .eq('id', user.id)
            .single();
        if (!profile || !profile.org_id) {
            return res.status(403).json({ code: 'NO_PROFILE', error: 'Профіль користувача не знайдено.' });
        }
        if (!profile.organizations || profile.organizations.status === 'blocked') {
            return res.status(403).json({ code: 'ORG_BLOCKED', error: 'Доступ компанії заблоковано адміністратором.' });
        }

        // --- Обов'язкові поля: без них результат був би вигаданим, тому відхиляємо ДО зарахування в ліміт демо ---
        const reqBody = req.body || {};
        const REQUIRED = {
            dist: 'Відстань', volume: 'Обсяг', normWeight: 'Норма завантаження', carsCount: 'Кількість авто',
            daysPerTrip: 'Днів на рейс', rate: 'Ставка', fuelLoad: 'Витрата з вантажем', fuelEmpty: 'Витрата порожнім',
            fuelPrice: 'Ціна палива', totalFleet: 'Авто в парку', toPeriod: 'Пробіг між ТО', tireMileage: 'Ресурс шин'
        };
        const isOneOff = reqBody.returnMode === 'разовий'; // разовий рейс: обсяг = норма × кількість авто, поле «Обсяг» не потрібне
        const missingFields = Object.keys(REQUIRED).filter(k => !(isOneOff && k === 'volume') && !(parseFloat(reqBody[k]) > 0));
        if (missingFields.length) {
            return res.status(400).json({
                code: 'MISSING_FIELDS',
                error: 'Заповніть: ' + missingFields.map(k => REQUIRED[k]).join(', '),
                fields: missingFields
            });
        }

        // Курс перевіряємо до ліміту демо, щоб зіпсований запит не з'їдав розрахунок.
        const contractCurrencyEarly = String(reqBody.contractCurrency || 'UAH').toUpperCase();
        if (contractCurrencyEarly === 'USD' || contractCurrencyEarly === 'EUR') {
            const fxEarly = parseFloat(reqBody.fxRate);
            if (!(fxEarly >= 10 && fxEarly <= 200)) {
                return res.status(400).json({
                    code: 'BAD_FX',
                    error: 'Немає курсу НБУ для валюти контракту. Оновіть сторінку.'
                });
            }
        } else if (contractCurrencyEarly !== 'UAH') {
            return res.status(400).json({ code: 'BAD_CCY', error: 'Валюта контракту: гривня, долар або євро.' });
        }

        // --- Демо-режим: ліміт лише з профілю в БД (is_approved). Клієнтський isDemo / ?preview ігнорується. ---
        const isDemo = !profile.is_approved;
        let demoInfo = null;
        if (isDemo) {
            // Лічильник атомарний на рівні бази (RPC bump_calc_usage); паралельними запитами ліміт не обійти
            const { data: allowed, error: bumpError } = await supabase.rpc('bump_calc_usage', {
                p_org: profile.org_id,
                p_limit: DEMO_DAILY_LIMIT
            });
            if (bumpError) {
                console.error('bump_calc_usage error:', bumpError);
                return res.status(500).json({ error: 'Не вдалося перевірити ліміт демо-режиму.' });
            }
            // Найсвіжіший рядок лічильника — це сьогоднішній (щойно оновлений у bump_calc_usage)
            const { data: usage } = await supabase
                .from('usage_counters')
                .select('calc_count')
                .eq('org_id', profile.org_id)
                .order('day', { ascending: false })
                .limit(1)
                .maybeSingle();
            const used = usage ? usage.calc_count : (allowed ? 1 : DEMO_DAILY_LIMIT);
            demoInfo = { used, limit: DEMO_DAILY_LIMIT };
            if (!allowed) {
                return res.status(429).json({
                    code: 'DEMO_LIMIT',
                    error: `Ліміт демо-режиму вичерпано: ${DEMO_DAILY_LIMIT} розрахунків на добу. Спробуйте завтра або отримайте повний доступ.`,
                    used: DEMO_DAILY_LIMIT,
                    limit: DEMO_DAILY_LIMIT
                });
            }
        }

        const result = calculateTrip(req.body || {});
        return res.status(200).json({ demo: demoInfo, ...result });

    } catch (err) {
        console.error('Calculation error:', err);
        return res.status(500).json({ error: err.message });
    }
}
