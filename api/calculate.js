export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = req.body || {};

        // 1. Вхідні параметри з форми
        const calcType = body.calcType || 'фоп'; // безготівковий, фоп, готівка
        const returnMode = body.returnMode || 'циклічний'; // циклічний, разовий
        const dist = parseFloat(body.dist) || 300;
        const podachaDist = parseFloat(body.podachaDist) || 30;
        const contractVolume = parseFloat(body.volume) || 3000;
        const normWeight = parseFloat(body.normWeight) || 21.5;
        const carsCount = parseFloat(body.carsCount) || 10;
        const daysPerTrip = parseFloat(body.daysPerTrip) || 1.33;
        const rate = parseFloat(body.rate) || 1560;

        // 2. Пальне та AdBlue
        const fuelLoadRate = parseFloat(body.fuelLoad) || 37;
        const fuelEmptyRate = parseFloat(body.fuelEmpty) || 32;
        const fuelPrice = parseFloat(body.fuelPrice) || 53;
        const adblueRate = parseFloat(body.adblueConsumption) || 2.85;
        const adbluePrice = parseFloat(body.adbluePrice) || 18;

        // 3. Зарплата водія та добові
        const driverPayMode = body.driverPayMode || 'km';
        const driverRateLoad = parseFloat(body.driverRateLoad) || 4.03;
        const driverRateEmpty = parseFloat(body.driverRateEmpty) || 2.30;
        const perDiem = parseFloat(body.perDiem) || 550;

        // 4. ТО та Шини
        const toCost = parseFloat(body.toCost) || 18000;
        const toPeriod = parseFloat(body.toPeriod) || 50000;
        const tireCost = parseFloat(body.tireCost) || 16500;
        const tireCount = parseFloat(body.tireCount) || 14;
        const tireMileage = parseFloat(body.tireMileage) || 150000;

        // 5. Накладні витрати підприємства (річні бюджети з Excel)
        const amortYear = parseFloat(body.amort) || 40139408;
        const adminYear = parseFloat(body.admin) || 17871209;
        const repairYear = parseFloat(body.repair) || 14305000;
        const finYear = parseFloat(body.fin) || 4308097.69;
        const totalFleet = parseFloat(body.totalFleet) || 68;
        const workDaysYear = 300;

        // Зворотний маршрут (якщо є)
        const isRoundTrip = body.isRoundTrip || false;
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
            totalEmptyKm = 0; // Після разового вивантаження авто не повертається в облік цього контракту
        } else {
            // Циклічний вивіз
            tripsCount = normWeight > 0 ? Math.ceil(contractVolume / normWeight) : 0;
            totalLoadedKm = dist * tripsCount;
            // Порожній пробіг: авто повертаються назад, окрім першої подачі, яка рахується окремо
            totalEmptyKm = dist * Math.max(0, tripsCount - carsCount);
        }

        // --- ДОХІД ---
        let grossIncome = actualVolume * rate;
        if (isRoundTrip && rtVolume > 0) {
            grossIncome += rtVolume * rtRate;
        }

        // Очищення від ПДВ для бази розрахунків (якщо вибрано безготівковий з ПДВ)
        let netIncome = calcType === 'безготівковий' ? grossIncome / 1.2 : grossIncome;

        // --- ПРЯМІ ВИТРАТИ ---
        // 1. Пальне (без ПДВ)
        const fuelLoadCost = (totalLoadedKm * fuelLoadRate / 100) * (fuelPrice / 1.2);
        const fuelEmptyCost = (totalEmptyKm * fuelEmptyRate / 100) * (fuelPrice / 1.2);
        const fuelPodachaCost = (totalPodachaKm * fuelEmptyRate / 100) * (fuelPrice / 1.2);
        const fuelTotal = fuelLoadCost + fuelEmptyCost + fuelPodachaCost;

        // 2. AdBlue
        const totalAllKm = totalLoadedKm + totalEmptyKm + totalPodachaKm;
        const adblueTotal = (totalAllKm * adblueRate / 100) * (adbluePrice / 1.2);

        // 3. Зарплата екіпажу та ЄСВ (22%)
        let salaryTotal = 0;
        if (driverPayMode === 'km') {
            salaryTotal = (totalLoadedKm * driverRateLoad) + ((totalEmptyKm + totalPodachaKm) * driverRateEmpty);
        } else {
            salaryTotal = grossIncome * (parseFloat(body.driverPctVal) || 12) / 100;
        }
        const esvTotal = salaryTotal * 0.22;

        // 4. Добові водія (пропорційно до кількості діб на всі ходки)
        const totalTripDays = tripsCount * daysPerTrip;
        const perDiemTotal = totalTripDays * perDiem;
        const driverTotal = salaryTotal + esvTotal + perDiemTotal;

        // 5. ТО, Шини та Ремонти
        const toPerKm = (toCost / 1.2) / toPeriod;
        const tirePerKm = (tireCost / 1.2) * tireCount / tireMileage;
        const toTotal = totalAllKm * toPerKm;
        const tireTotal = totalAllKm * tirePerKm;
        
        // Ремонти (пропорційно дням роботи авто за Excel: Річний бюджет / Дні / Авто)
        const repairDaily = (repairYear / 1.2) / (totalFleet * workDaysYear);
        const repairTotal = repairDaily * totalTripDays;
        
        const maintenanceTotal = toTotal + tireTotal + repairTotal;

        // --- МАРЖИНАЛЬНИЙ ДОХІД ---
        const directCostsTotal = fuelTotal + adblueTotal + driverTotal + maintenanceTotal;
        const marginalIncome = netIncome - directCostsTotal;

        // --- НАКЛАДНІ ВИТРАТИ ПІДПРИЄМСТВА (на дні рейсу) ---
        // Амортизація та Адмін зазвичай не містять ПДВ або вже очищені в бюджеті
        const dailyAmort = amortYear / (totalFleet * workDaysYear);
        const dailyAdmin = adminYear / (totalFleet * workDaysYear);
        const dailyFin = finYear / (totalFleet * workDaysYear);
        const overheadTotal = (dailyAmort + dailyAdmin + dailyFin) * totalTripDays;

        // --- ПОДАТКИ ТА ПРИБУТОК ---
        let taxesTotal = 0;
        
        // Попередній розрахунок прибутку до оподаткування
        const profitBeforeTax = marginalIncome - overheadTotal;

        if (calcType === 'фоп') {
            // ФОП 3 група: 5% єдиний податок + 1% військовий збір від усього брудного доходу
            taxesTotal = grossIncome * 0.06;
        } else if (calcType === 'безготівковий') {
            // ТОВ з ПДВ (Загальна система): ПДВ вже відмінусовано (/ 1.2) у доходах і витратах.
            // Рахуємо 18% податку на прибуток підприємства (лише якщо є плюсовий прибуток).
            taxesTotal = profitBeforeTax > 0 ? profitBeforeTax * 0.18 : 0;
        }

        const ebitda = profitBeforeTax;
        const netProfit = ebitda - taxesTotal;
        
        // Відсоток прибутковості (рентабельність)
        const profitabilityPct = netIncome > 0 ? (netProfit / netIncome) * 100 : 0;

        // Точка беззбитковості (грн/т)
        const totalAllCosts = directCostsTotal + overheadTotal + taxesTotal;
        const breakevenFullPerTon = actualVolume > 0 ? Math.round(totalAllCosts / actualVolume) : 0;
        const breakevenOpPerTon = actualVolume > 0 ? Math.round((directCostsTotal + overheadTotal) / actualVolume) : 0;

        // Розшифровка витрат для таблиці
        const detailedRows = [
            { name: '⛽ Пальне (ДП завантажений + пустий + подача)', val: Math.round(fuelTotal) },
            { name: '💧 Рідина AdBlue', val: Math.round(adblueTotal) },
            { name: '👨‍✈️ Зарплата екіпажу + ЄСВ (22%) + Добові', val: Math.round(driverTotal) },
            { name: '🔧 ТО, Шини та Ремонти', val: Math.round(maintenanceTotal) },
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
            netProfit: Math.round(netProfit),
            profitabilityPct,
            breakevenFullPerTon,
            breakevenOpPerTon,
            
            // Змінні для графіку (Блок 2 Візуалізація)
            fuelTotal: Math.round(fuelTotal + adblueTotal),
            driverTotal: Math.round(driverTotal),
            toTotal: Math.round(maintenanceTotal),
            overheadTotal: Math.round(overheadTotal),
            taxesTotal: Math.round(taxesTotal),
            
            detailedRows,
            tripVolumeText: `Об'єм вивозу: ${tripsCount} ходок (${actualVolume} тн)`,
            podachaText: `Витрати на подачу: ${Math.round(fuelPodachaCost)} грн (${totalPodachaKm} км)`,
            fuelSummaryText: `⛽ Пальне: заг. пробіг ${totalAllKm} км | Витрати: ${Math.round(fuelTotal)} грн`
        });

    } catch (err) {
        console.error('Calculation error:', err);
        return res.status(500).json({ error: err.message });
    }
}
