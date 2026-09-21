export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = req.body || {};

        // Вхідні параметри з форми
        const calcType = body.calcType || 'фоп'; // безготівковий, фоп, готівка
        const returnMode = body.returnMode || 'циклічний'; // циклічний, разовий
        const dist = parseFloat(body.dist) || 300;
        const podachaDist = parseFloat(body.podachaDist) || 30;
        const contractVolume = parseFloat(body.volume) || 3000;
        const normWeight = parseFloat(body.normWeight) || 21.5;
        const carsCount = parseFloat(body.carsCount) || 10;
        const daysPerTrip = parseFloat(body.daysPerTrip) || 1.33;
        const rate = parseFloat(body.rate) || 1560; // грн за тн

        // Пальне та AdBlue
        const fuelLoadRate = parseFloat(body.fuelLoad) || 37;
        const fuelEmptyRate = parseFloat(body.fuelEmpty) || 32;
        const fuelPrice = parseFloat(body.fuelPrice) || 53;
        const adblueRate = parseFloat(body.adblueConsumption) || 2.85;
        const adbluePrice = parseFloat(body.adbluePrice) || 18;

        // Зарплата водія та добові
        const driverPayMode = body.driverPayMode || 'km';
        const driverRateLoad = parseFloat(body.driverRateLoad) || 4.03;
        const driverRateEmpty = parseFloat(body.driverRateEmpty) || 2.30;
        const perDiem = parseFloat(body.perDiem) || 550;

        // ТО та Шини
        const toCost = parseFloat(body.toCost) || 18000;
        const toPeriod = parseFloat(body.toPeriod) || 50000;
        const tireCost = parseFloat(body.tireCost) || 16500;
        const tireCount = parseFloat(body.tireCount) || 14;
        const tireMileage = parseFloat(body.tireMileage) || 150000;

        // Накладні витрати підприємства (річні з Excel)
        const amortYear = parseFloat(body.amort) || 40139408;
        const adminYear = parseFloat(body.admin) || 17871209;
        const repairYear = parseFloat(body.repair) || 16124943;
        const finYear = parseFloat(body.fin) || 4308097.69;
        const totalFleet = parseFloat(body.totalFleet) || 68;
        const workDaysYear = 300; // 25 днів * 12 місяців

        // Зворотний маршрут (якщо увімкнено)
        const isRoundTrip = body.isRoundTrip || false;
        const rtBackhaulDist = parseFloat(body.rtBackhaulDist) || 0;
        const rtRate = parseFloat(body.rtRate) || 0;
        const rtVolume = parseFloat(body.rtTotalVolume) || 0;

        // --- РОЗРАХУНОК ХОДОК ТА ПРОБІГІВ ---
        let tripsCount = 0;
        let actualVolume = contractVolume;
        let totalLoadedKm = 0;
        let totalEmptyKm = 0;
        let totalPodachaKm = podachaDist * carsCount;

        if (returnMode === 'разовий') {
            tripsCount = carsCount;
            actualVolume = normWeight * carsCount;
            totalLoadedKm = dist * carsCount;
            totalEmptyKm = 0;
        } else {
            tripsCount = normWeight > 0 ? Math.ceil(contractVolume / normWeight) : 0;
            totalLoadedKm = dist * tripsCount;
            totalEmptyKm = dist * Math.max(0, tripsCount - carsCount);
        }

        // --- ДОХІД ---
        let grossIncome = actualVolume * rate;
        if (isRoundTrip && rtVolume > 0) {
            grossIncome += rtVolume * rtRate;
        }

        let netIncome = calcType === 'безготівковий' ? grossIncome / 1.2 : grossIncome;

        // --- ПРЯМІ ВИТРАТИ ---
        // Пальне (завантажений, пустий, подача)
        const fuelLoadCost = (totalLoadedKm * fuelLoadRate / 100) * (fuelPrice / 1.2);
        const fuelEmptyCost = (totalEmptyKm * fuelEmptyRate / 100) * (fuelPrice / 1.2);
        const fuelPodachaCost = (totalPodachaKm * fuelEmptyRate / 100) * (fuelPrice / 1.2);
        const fuelTotal = fuelLoadCost + fuelEmptyCost + fuelPodachaCost;

        // AdBlue
        const totalAllKm = totalLoadedKm + totalEmptyKm + totalPodachaKm;
        const adblueTotal = (totalAllKm * adblueRate / 100) * (adbluePrice / 1.2);

        // Зарплата водія та ЄСВ (22%)
        let salaryTotal = 0;
        if (driverPayMode === 'km') {
            salaryTotal = (totalLoadedKm * driverRateLoad) + ((totalEmptyKm + totalPodachaKm) * driverRateEmpty);
        } else {
            salaryTotal = grossIncome * (parseFloat(body.driverPctVal) || 12) / 100;
        }
        const esvTotal = salaryTotal * 0.22;

        // Добові водія (на основі діб рейсів)
        const totalTripDays = tripsCount * daysPerTrip;
        const perDiemTotal = totalTripDays * perDiem;

        // ТО та Шини на км пробігу
        const toPerKm = (toCost / 1.2) / toPeriod;
        const tirePerKm = (tireCost / 1.2) * tireCount / tireMileage;
        const toTotal = totalAllKm * toPerKm;
        const tireTotal = totalAllKm * tirePerKm;

        // Ремонти (пропорційно дням рейсів)
        const repairDaily = (repairYear / 1.2) / (totalFleet * workDaysYear);
        const repairTotal = repairDaily * totalTripDays;

        const directCostsTotal = fuelTotal + adblueTotal + salaryTotal + esvTotal + perDiemTotal + toTotal + tireTotal + repairTotal;

        // --- МАРЖИНАЛЬНИЙ ДОХІД ---
        const marginalIncome = netIncome - directCostsTotal;

        // --- НАКЛАДНІ ВИТРАТИ ПІДПРИЄМСТВА (розподіл на дні рейсу) ---
        const dailyAmort = (amortYear / 1.2) / (totalFleet * workDaysYear);
        const dailyAdmin = (adminYear / 1.2) / (totalFleet * workDaysYear);
        const dailyFin = (finYear / 1.2) / (totalFleet * workDaysYear);

        const overheadTotal = (dailyAmort + dailyAdmin + dailyFin) * totalTripDays;

        // --- EBITDA ТА ПРИБУТОК ---
        const ebitda = marginalIncome - overheadTotal;
        const netProfit = ebitda; // Чистий прибуток після всіх операційних та накладних витрат

        // Податки (якщо ФОП 3 група: 5% + 1% ВЗ)
        let taxesTotal = 0;
        if (calcType === 'фоп') {
            taxesTotal = grossIncome * 0.06;
        }

        const finalProfit = netProfit - taxesTotal;
        const profitabilityPct = netIncome > 0 ? (finalProfit / netIncome) * 100 : 0;

        // Точка беззбитковості (грн/т)
        const totalAllCosts = directCostsTotal + overheadTotal + taxesTotal;
        const breakevenFullPerTon = actualVolume > 0 ? Math.round(totalAllCosts / actualVolume) : 0;
        const breakevenOpPerTon = actualVolume > 0 ? Math.round((directCostsTotal + overheadTotal) / actualVolume) : 0;

        // Розшифровка витрат для таблиці
        const detailedRows = [
            { name: '⛽ Пальне (ДП завантажений + пустий + подача)', val: Math.round(fuelTotal) },
            { name: '💧 Рідина AdBlue', val: Math.round(adblueTotal) },
            { name: '👨‍✈️ Зарплата екіпажу + ЄСВ (22%)', val: Math.round(salaryTotal + esvTotal) },
            { name: '🍽️ Добові водія', val: Math.round(perDiemTotal) },
            { name: '🔧 Технічне обслуговування (ТО)', val: Math.round(toTotal) },
            { name: '🛞 Комплект шин', val: Math.round(tireTotal) },
            { name: '🛠️ Поточні ремонти', val: Math.round(repairTotal) },
            { name: '🏢 Накладні витрати (амортизація, адмін, фін)', val: Math.round(overheadTotal) },
            { name: '🏛️ Податки (ФОП / ПДВ)', val: Math.round(taxesTotal) }
        ];

        return res.status(200).json({
            grossIncome: Math.round(grossIncome),
            netIncome: Math.round(netIncome),
            marginalIncome: Math.round(marginalIncome),
            marginPerTon: actualVolume > 0 ? Math.round(marginalIncome / actualVolume) : 0,
            ebitda: Math.round(ebitda),
            ebitdaPerTon: actualVolume > 0 ? Math.round(ebitda / actualVolume) : 0,
            netProfit: Math.round(finalProfit),
            profitabilityPct,
            breakevenFullPerTon,
            breakevenOpPerTon,
            fuelTotal: Math.round(fuelTotal),
            driverTotal: Math.round(salaryTotal + esvTotal + perDiemTotal),
            toTotal: Math.round(toTotal + tireTotal + repairTotal),
            overheadTotal: Math.round(overheadTotal),
            taxesTotal: Math.round(taxesTotal),
            detailedRows,
            tripVolumeText: `Повний вивіз: ${tripsCount} ходок (${actualVolume} тн)`,
            podachaText: `Витрати на подачу: ${Math.round(fuelPodachaCost)} грн (${totalPodachaKm} км)`,
            fuelSummaryText: `⛽ Пальне: заг. пробіг ${totalAllKm} км | Витрати: ${Math.round(fuelTotal)} грн`
        });

    } catch (err) {
        console.error('Calculation error:', err);
        return res.status(500).json({ error: err.message });
    }
}
