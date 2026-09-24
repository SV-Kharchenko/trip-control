import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
            .select('is_approved')
            .eq('id', user.id)
            .single();
        if (!profile || !profile.is_approved) {
            return res.status(403).json({ error: 'Акаунт очікує підтвердження адміністратора.' });
        }

        const body = req.body || {};

        // 1. Вхідні параметри
        const calcType = body.calcType || 'фоп';
        const returnMode = body.returnMode || 'циклічний';
        const trailerType = body.trailerType || 'зерновоз';
        const roadQuality = parseFloat(body.roadQuality) || 1.0;
        const dist = parseFloat(body.dist) || 300;
        const podachaDist = parseFloat(body.podachaDist) || 30;
        const contractVolume = parseFloat(body.volume) || 3000;
        const normWeight = parseFloat(body.normWeight) || 21.5;
        const carsCount = parseFloat(body.carsCount) || 10;
        const daysPerTrip = parseFloat(body.daysPerTrip) || 1.33;
        const idleDays = parseFloat(body.idleDays) || 0;
        const idleRate = parseFloat(body.idleRate) || 0;
        const rate = parseFloat(body.rate) || 1560;

        // ПДВ-кредит на вхідні витрати отримує лише платник ПДВ (безготівковий розрахунок).
        // ФОП і готівка платять повну ціну — тому дільник застосовуємо умовно, а не завжди.
        const vatDivisor = calcType === 'безготівковий' ? 1.2 : 1.0;

        // 2. Пальне та AdBlue
        const season = body.season || 'стандарт';
        let seasonCoeff = 1.0;
        if (season === 'літо') seasonCoeff = 1.05;
        else if (season === 'зима') seasonCoeff = 1.10;

        const fuelLoadRate = (parseFloat(body.fuelLoad) || 37) * seasonCoeff * roadQuality;
        const fuelEmptyRate = (parseFloat(body.fuelEmpty) || 32) * seasonCoeff * roadQuality;
        const fuelPrice = parseFloat(body.fuelPrice) || 53;

        const useAdblue = body.useAdblue !== false; // за замовчуванням увімкнено, якщо не передано інше
        const adblueRate = parseFloat(body.adblueConsumption) || 2.85;
        const adbluePrice = parseFloat(body.adbluePrice) || 18;

        // 3. Зарплата та добові
        const driverPayMode = body.driverPayMode || 'km';
        const driverRateLoad = parseFloat(body.driverRateLoad) || 4.03;
        const driverRateEmpty = parseFloat(body.driverRateEmpty) || 2.30;
        const driverPctVal = parseFloat(body.driverPctVal) || 12;
        const perDiem = parseFloat(body.perDiem) || 550;

        // 4. ТО, Шини, спецвитрати причепа
        const toCost = parseFloat(body.toCost) || 18000;
        const toPeriod = parseFloat(body.toPeriod) || 50000;
        const tireCost = parseFloat(body.tireCost) || 16500;
        const tireCount = parseFloat(body.tireCount) || 14;
        const tireMileage = parseFloat(body.tireMileage) || 150000;

        const washCost = parseFloat(body.washCost) || 0;      // цистерна: промивка
        const washFreq = parseFloat(body.washFreq) || 0;      // раз/рік
        const refFuelRate = parseFloat(body.refFuelRate) || 0; // рефрижератор: л/год
        const refHours = parseFloat(body.refHours) || 0;       // годин/рейс

        // 4б. Супутні витрати (платні дороги, кордон, брокер, страховка, паром) — за рейс/ходку
        const useExtras = body.useExtras === true;
        const tollCost = useExtras ? (parseFloat(body.tollCost) || 0) : 0;
        const borderCost = useExtras ? (parseFloat(body.borderCost) || 0) : 0;
        const brokerCost = useExtras ? (parseFloat(body.brokerCost) || 0) : 0;
        const greenCardCost = useExtras ? (parseFloat(body.greenCardCost) || 0) : 0;
        const ferryCost = useExtras ? (parseFloat(body.ferryCost) || 0) : 0;

        // 5. Накладні витрати (амортизація/фін. витрати — не VAT-товар, ремонт — VAT-товар)
        const amortYear = parseFloat(body.amort) || 40139408;
        const adminYear = parseFloat(body.admin) || 17871209;
        const otherOpYear = parseFloat(body.otherOperating) || 0;   // "Інші операційні витрати"
        const otherExpYear = parseFloat(body.otherExpenses) || 0;   // "Накладні витрати. Інші витрати"
        const repairYear = parseFloat(body.repair) || 14305000;
        const finYear = parseFloat(body.fin) || 4308097.69;
        const totalFleet = parseFloat(body.totalFleet) || 68;
        const workDaysYear = 300;

        // --- ХОДКИ ТА ПРОБІГИ ---
        let tripsCount = 0;
        let actualVolume = contractVolume;
        let totalLoadedKm = 0;
        let totalEmptyKm = 0;
        const totalPodachaKm = podachaDist * carsCount;

        if (returnMode === 'разовий') {
            tripsCount = carsCount;
            actualVolume = normWeight * carsCount;
            totalLoadedKm = dist * carsCount;
            totalEmptyKm = 0;
        } else {
            tripsCount = normWeight > 0 ? Math.ceil(contractVolume / normWeight) : 0;
            actualVolume = contractVolume;
            totalLoadedKm = dist * tripsCount;
            totalEmptyKm = dist * Math.max(0, tripsCount - carsCount);
        }

        // --- КРУГОРЕЙС: B→C (порожнім) → C→D (вантаженим) → D→A (порожнім) ---
        // Довантажуємо стільки порожніх зворотних ходок, скільки реально дозволяє заявлений
        // обсяг зворотнього вантажу (не більше) і скільки їх фізично є (не більше numReturnLegs).
        const isRoundTrip = body.isRoundTrip === true;
        const rtTransferDist = isRoundTrip ? (parseFloat(body.rtTransferDist) || 0) : 0;
        const rtBackhaulDist = isRoundTrip ? (parseFloat(body.rtBackhaulDist) || 0) : 0;
        const rtReturnDist = isRoundTrip ? (parseFloat(body.rtReturnDist) || 0) : 0;
        const rtTotalVolumeAvailable = isRoundTrip ? (parseFloat(body.rtTotalVolume) || 0) : 0;
        const rtRate = isRoundTrip ? (parseFloat(body.rtRate) || 0) : 0;

        const numReturnLegs = (returnMode === 'разовий') ? 0 : Math.max(0, tripsCount - carsCount);
        const maxLegsByCapacity = normWeight > 0 ? Math.floor(rtTotalVolumeAvailable / normWeight) : 0;
        const rtLegsUsed = isRoundTrip ? Math.min(numReturnLegs, maxLegsByCapacity) : 0;
        const rtVolumeTotal = Math.min(rtTotalVolumeAvailable, rtLegsUsed * normWeight);
        const rtIncome = rtVolumeTotal * rtRate;

        if (rtLegsUsed > 0) {
            // Ці ходки більше не їдуть порожняком напряму (dist кожна) — замість цього їдуть
            // реальним контуром: порожнім до C, вантаженим до D, порожнім назад до A.
            totalEmptyKm = Math.max(0, totalEmptyKm - rtLegsUsed * dist + rtLegsUsed * (rtTransferDist + rtReturnDist));
            totalLoadedKm += rtLegsUsed * rtBackhaulDist;
        }

        // --- ДОХІД ---
        const idleCompensationTotal = idleDays * idleRate * (returnMode === 'разовий' ? carsCount : tripsCount);
        const grossIncome = (actualVolume * rate) + rtIncome + idleCompensationTotal;

        // --- ПДВ і "Чистий дохід" ---
        // Для безготівкового доходу база для маржі/прибутку — це дохід БЕЗ ПДВ (gross/1.2),
        // так само як витрати рахуються без ПДВ (vatDivisor вище). ПДВ тут не окрема "витрата" —
        // це податок, що йде транзитом державі, і його просто виключають з бази, а не віднімають
        // окремим рядком (інакше він списався б двічі: і тут, і в taxesTotal нижче).
        let netIncome = grossIncome;
        if (calcType === 'безготівковий') {
            netIncome = grossIncome / 1.2;
        }

        // --- ПОДАТКИ ФОП (рахуються один раз, після EBITDA) ---
        // Для безготівкового тут 0: ПДВ уже виключений вище через netIncome, а не через цю статтю.
        let taxesTotal = 0;
        if (calcType === 'фоп') {
            taxesTotal = grossIncome * 0.06; // 5% ЄП + 1% ВЗ
        }
        // 'готівка' і 'безготівковий' — податок тут не рахуємо (для 'готівка' його й немає)

        // --- ПРЯМІ ВИТРАТИ ---
        const fuelLoadCost = (totalLoadedKm * fuelLoadRate / 100) * (fuelPrice / vatDivisor);
        const fuelEmptyCost = (totalEmptyKm * fuelEmptyRate / 100) * (fuelPrice / vatDivisor);
        const fuelPodachaCost = (totalPodachaKm * fuelEmptyRate / 100) * (fuelPrice / vatDivisor);

        let refFuelCost = 0;
        if (trailerType === 'рефрижератор' && refFuelRate > 0) {
            refFuelCost = refFuelRate * refHours * (fuelPrice / vatDivisor) * (returnMode === 'разовий' ? carsCount : tripsCount);
        }

        const fuelTotal = fuelLoadCost + fuelEmptyCost + fuelPodachaCost + refFuelCost;
        const totalAllKm = totalLoadedKm + totalEmptyKm + totalPodachaKm;

        let adblueTotal = 0;
        if (useAdblue) {
            adblueTotal = (totalAllKm * adblueRate / 100) * (adbluePrice / vatDivisor);
        }

        let salaryTotal = 0;
        if (driverPayMode === 'km') {
            salaryTotal = (totalLoadedKm * driverRateLoad) + ((totalEmptyKm + totalPodachaKm) * driverRateEmpty);
        } else {
            salaryTotal = grossIncome * (driverPctVal / 100);
        }
        const esvTotal = salaryTotal * 0.22;

        // Загальна кількість "діб у рейсі" по всьому парку разом, з урахуванням простою
        const totalTripDays = tripsCount * (daysPerTrip + idleDays);
        const perDiemTotal = totalTripDays * perDiem;
        const driverTotal = salaryTotal + esvTotal + perDiemTotal;

        const toCostAdj = toCost * (1 + (roadQuality - 1) * 0.5);
        const tireCostAdj = tireCost * (1 + (roadQuality - 1) * 0.5);

        const toPerKm = (toCostAdj / vatDivisor) / toPeriod;
        const tirePerKm = (tireCostAdj / vatDivisor) * tireCount / tireMileage;
        const toTotal = totalAllKm * toPerKm;
        const tireTotal = totalAllKm * tirePerKm;

        let tankWashTotal = 0;
        if (trailerType === 'цистерна' && washCost > 0) {
            // Промивка — витрата всього парку за рік, розподіляємо на цей рейс пропорційно дням
            const annualTankWash = (washCost * washFreq) / vatDivisor;
            tankWashTotal = (annualTankWash / totalFleet / workDaysYear) * totalTripDays;
        }

        const repairDaily = (repairYear / vatDivisor) / (totalFleet * workDaysYear);
        const repairTotal = repairDaily * totalTripDays;

        const maintenanceTotal = toTotal + tireTotal + repairTotal + tankWashTotal;

        // Супутні витрати — разові на рейс/ходку (платні дороги, кордон, брокер, зелена карта, паром)
        const extrasPerTrip = tollCost + borderCost + brokerCost + greenCardCost + ferryCost;
        const extrasTotal = extrasPerTrip * (returnMode === 'разовий' ? carsCount : tripsCount);

        const directCostsTotal = fuelTotal + adblueTotal + driverTotal + maintenanceTotal + extrasTotal;
        const marginalIncome = netIncome - directCostsTotal;

        // --- НАКЛАДНІ ВИТРАТИ ---
        // EBITDA за визначенням — прибуток ДО амортизації й фінансових витрат, тому вони
        // не повинні зменшувати EBITDA; віднімаються лише на етапі netProfit (як і в Excel:
        // I41=I36-SUM(адмін,інші_оп,інші_витрати), I44=I41-SUM(амортизація,фін.витрати)).
        const dailyAdmin = adminYear / (totalFleet * workDaysYear);
        const dailyOtherOp = otherOpYear / (totalFleet * workDaysYear);
        const dailyOtherExp = otherExpYear / (totalFleet * workDaysYear);
        const dailyAmort = amortYear / (totalFleet * workDaysYear);
        const dailyFin = finYear / (totalFleet * workDaysYear);

        const ebitdaOverheadTotal = (dailyAdmin + dailyOtherOp + dailyOtherExp) * totalTripDays;
        const postEbitdaTotal = (dailyAmort + dailyFin) * totalTripDays;
        const overheadTotal = ebitdaOverheadTotal + postEbitdaTotal; // повна сума, для беззбитковості й діаграми

        const ebitda = marginalIncome - ebitdaOverheadTotal;
        const netProfit = ebitda - postEbitdaTotal - taxesTotal; // тепер амортизація/фін віднімаються тут, а не в EBITDA

        const profitabilityPct = netIncome > 0 ? (netProfit / netIncome) * 100 : 0;
        const totalAllCosts = directCostsTotal + overheadTotal + taxesTotal;
        const breakevenFullPerTon = actualVolume > 0 ? Math.round(totalAllCosts / actualVolume) : 0;
        const breakevenOpPerTon = actualVolume > 0 ? Math.round((directCostsTotal + overheadTotal) / actualVolume) : 0;

        const detailedRows = [
            { name: '⛽ Пальне (ДП завантажений + пустий + подача' + (refFuelCost > 0 ? ' + реф' : '') + ')', val: Math.round(fuelTotal) },
            { name: useAdblue ? '💧 Рідина AdBlue' : '💧 Рідина AdBlue (Вимкнено)', val: Math.round(adblueTotal) },
            { name: '👨‍✈️ Зарплата екіпажу + ЄСВ (22%) + Добові', val: Math.round(driverTotal) },
            { name: '🔧 ТО, Шини та Ремонти' + (tankWashTotal > 0 ? ' + промивка цистерни' : ''), val: Math.round(maintenanceTotal) },
            ...(useExtras ? [{ name: '🌍 Супутні витрати (дороги, кордон, брокер, страховка, паром)', val: Math.round(extrasTotal) }] : []),
            { name: '🏢 Накладні до EBITDA (адмін + інші операційні + інші витрати)', val: Math.round(ebitdaOverheadTotal) },
            { name: '📉 Амортизація та фінансові витрати (після EBITDA)', val: Math.round(postEbitdaTotal) },
            { name: '🏛️ Податки (ФОП / ПДВ)', val: Math.round(taxesTotal) }
        ];

        let tripVolumeText = returnMode === 'разовий'
            ? `Об'єм разового рейсу: ${actualVolume.toFixed(1)} тн (${carsCount} авто по ${normWeight} тн)`
            : `Об'єм вивозу: ${tripsCount} ходок (${actualVolume} тн)`;

        if (isRoundTrip) {
            tripVolumeText += rtLegsUsed > 0
                ? ` | 🔄 Кругорейс: ${rtLegsUsed} з ${numReturnLegs} зворотних ходок довантажено (${rtVolumeTotal.toFixed(1)} тн)`
                : ` | 🔄 Кругорейс: недостатньо обсягу/ходок для довантаження`;
        }

        const rtInfoText = numReturnLegs > 0
            ? `Доступно зворотних ходок: ${numReturnLegs} | Використано: ${rtLegsUsed} (обмежено ${numReturnLegs <= maxLegsByCapacity ? 'кількістю ходок' : 'обсягом вантажу'})`
            : (isRoundTrip ? 'Немає порожніх зворотних ходок у цьому рейсі' : '');

        const podachaText = totalPodachaKm > 0
            ? `Витрати на подачу: ${Math.round(fuelPodachaCost)} грн (${totalPodachaKm} км)`
            : '';

        const fuelSummaryText = `⛽ Пальне: заг. пробіг ${totalAllKm} км | Витрати: ${Math.round(fuelTotal)} грн`;
        const adblueSummaryText = useAdblue
            ? `💧 AdBlue: витрати ${Math.round(adblueTotal)} грн`
            : '💧 AdBlue: не використовується';

        return res.status(200).json({
            grossIncome: Math.round(grossIncome),
            netIncome: Math.round(netIncome),
            marginalIncome: Math.round(marginalIncome),
            marginPerTon: actualVolume > 0 ? Math.round(marginalIncome / actualVolume) : 0,
            ebitda: Math.round(ebitda),
            ebitdaPerTon: actualVolume > 0 ? Math.round(ebitda / actualVolume) : 0,
            netProfit: Math.round(netProfit),
            profitabilityPct,
            breakevenFullPerTon,
            breakevenOpPerTon,
            fuelTotal: Math.round(fuelTotal + adblueTotal),
            driverTotal: Math.round(driverTotal),
            toTotal: Math.round(maintenanceTotal),
            extrasTotal: Math.round(extrasTotal),
            overheadTotal: Math.round(overheadTotal),
            taxesTotal: Math.round(taxesTotal),
            detailedRows,

            tripVolumeText,
            rtInfoText,
            podachaText,
            fuelSummaryText,
            adblueSummaryText
        });

    } catch (err) {
        console.error('Calculation error:', err);
        return res.status(500).json({ error: err.message });
    }
}
