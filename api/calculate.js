import { createClient } from '@supabase/supabase-js';
import { USER_BLOCKED_ERROR, userIsBlocked } from '../lib/account-block.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Скільки розрахунків на добу дозволено в демо-режимі (акаунт без схвалення адміністратором)
const DEMO_DAILY_LIMIT = 5;

// AdBlue «Є», а норма чи ціна порожні: беремо типові значення, а не 0.
export const DEFAULT_ADBLUE_RATE = 2.5;   // л/100 км
export const DEFAULT_ADBLUE_PRICE = 18;   // грн/л

// Необов'язкові статті: порожньо чи 0 → стаття рахується як 0, і про це
// повертаємо попередження. Типових значень тут не підставляємо.
const OPTIONAL_COSTS = [
    { key: 'amort', label: 'Амортизація' },
    { key: 'admin', label: 'Адміністративні витрати' },
    { key: 'otherOperating', label: 'Інші операційні витрати' },
    { key: 'otherExpenses', label: 'Інші витрати' },
    { key: 'repair', label: 'Ремонти та інші оп. витрати' },
    { key: 'fin', label: 'Фінансові витрати (кредити)' },
    { key: 'driverRateLoad', label: 'Ставка водія з вантажем', when: b => (b.driverPayMode || 'km') === 'km' },
    { key: 'driverRateEmpty', label: 'Ставка водія порожнім', when: b => (b.driverPayMode || 'km') === 'km' },
    { key: 'driverPctVal', label: 'Відсоток водія від фрахту', when: b => b.driverPayMode === 'pct' },
    { key: 'perDiem', label: 'Добові' },
    { key: 'toCost', label: 'Вартість ТО' },
    { key: 'tireCost', label: 'Ціна однієї шини' },
    { key: 'tireCount', label: 'Кількість шин' },
    { key: 'washCost', label: 'Вартість промивки цистерни', when: b => (b.trailerType || 'зерновоз') === 'цистерна' },
    { key: 'washFreq', label: 'Промивок на рік', when: b => (b.trailerType || 'зерновоз') === 'цистерна' },
    { key: 'refFuelRate', label: 'Витрата пального рефрижератора', when: b => (b.trailerType || 'зерновоз') === 'рефрижератор' },
    { key: 'refHours', label: 'Години роботи рефрижератора', when: b => (b.trailerType || 'зерновоз') === 'рефрижератор' }
];

export function emptyCostWarnings(body) {
    body = body || {};
    return OPTIONAL_COSTS
        .filter(item => !item.when || item.when(body))
        .filter(item => !(parseFloat(body[item.key]) > 0))
        .map(item => ({ key: item.key, label: item.label }));
}

// Чистий розрахунок рейсу. Арифметика та сама, що віддає POST /api/calculate.
// Авторизація, демо-ліміт і поле demo лишаються в handler.
// Публічний результат округлюється як і раніше. Незаокруглені маржа, EBITDA
// й амортизація лишаються лише для суми кількох авто.
export function calculateTrip(body) {
    const computed = computeTrip(body);
    if (!computed || computed.status) return computed;
    return computed.public;
}

function computeTrip(body) {
    body = body || {};

    // 1. Вхідні параметри
    const calcType = body.calcType || 'фоп';
    const returnMode = body.returnMode || 'циклічний';
    const trailerType = body.trailerType || 'зерновоз';
    const roadQuality = parseFloat(body.roadQuality) || 1.0;
    const dist = parseFloat(body.dist);
    const podachaDist = parseFloat(body.podachaDist) || 0;
    const contractVolume = parseFloat(body.volume) || 0; // у разовому рейсі обсяг не використовується (норма × авто)
    const normWeight = parseFloat(body.normWeight);
    const carsCount = parseFloat(body.carsCount);
    const daysPerTrip = parseFloat(body.daysPerTrip);
    const idleDays = parseFloat(body.idleDays) || 0;
    // Валюта контракту: розцінка, простій, зворотний вантаж і супутні витрати
    // приходять у ній. Пальне, ТО і накладні лишаються в гривні, тому суми
    // контракту переводимо в грн за курсом, який клієнт взяв з НБУ.
    const contractCurrency = String(body.contractCurrency || 'UAH').toUpperCase();
    let fxRate = 1;
    if (contractCurrency === 'USD' || contractCurrency === 'EUR') {
        fxRate = parseFloat(body.fxRate);
        if (!(fxRate >= 10 && fxRate <= 200)) {
            return {
                status: 400,
                code: 'BAD_FX',
                error: 'Немає курсу НБУ для валюти контракту. Оновіть сторінку.'
            };
        }
    } else if (contractCurrency !== 'UAH') {
        return { status: 400, code: 'BAD_CCY', error: 'Валюта контракту: гривня, долар або євро.' };
    }
    const idleRate = (parseFloat(body.idleRate) || 0) * fxRate;
    const rate = parseFloat(body.rate) * fxRate;

    // ПДВ-кредит на вхідні витрати отримує лише платник ПДВ (безготівковий розрахунок).
    // ФОП і готівка платять повну ціну — тому дільник застосовуємо умовно, а не завжди.
    const vatDivisor = calcType === 'безготівковий' ? 1.2 : 1.0;

    // 2. Пальне та AdBlue
    const season = body.season || 'стандарт';
    let seasonCoeff = 1.0;
    if (season === 'літо') seasonCoeff = 1.05;
    else if (season === 'зима') seasonCoeff = 1.10;

    const fuelLoadRate = parseFloat(body.fuelLoad) * seasonCoeff * roadQuality;
    const fuelEmptyRate = parseFloat(body.fuelEmpty) * seasonCoeff * roadQuality;
    const fuelPrice = parseFloat(body.fuelPrice);

    const useAdblue = body.useAdblue !== false; // за замовчуванням увімкнено, якщо не передано інше
    const adblueRate = useAdblue ? (parseFloat(body.adblueConsumption) || DEFAULT_ADBLUE_RATE) : 0;
    const adbluePrice = useAdblue ? (parseFloat(body.adbluePrice) || DEFAULT_ADBLUE_PRICE) : 0;

    // 3. Зарплата та добові
    const driverPayMode = body.driverPayMode || 'km';
    const driverRateLoad = parseFloat(body.driverRateLoad) || 0;
    const driverRateEmpty = parseFloat(body.driverRateEmpty) || 0;
    const driverPctVal = parseFloat(body.driverPctVal) || 0;
    const perDiem = parseFloat(body.perDiem) || 0;

    // 4. ТО, Шини, спецвитрати причепа
    const toCost = parseFloat(body.toCost) || 0;
    const toPeriod = parseFloat(body.toPeriod);
    const tireCost = parseFloat(body.tireCost) || 0;
    const tireCount = parseFloat(body.tireCount) || 0;
    const tireMileage = parseFloat(body.tireMileage);

    const washCost = parseFloat(body.washCost) || 0;      // цистерна: промивка
    const washFreq = parseFloat(body.washFreq) || 0;      // раз/рік
    const refFuelRate = parseFloat(body.refFuelRate) || 0; // рефрижератор: л/год
    const refHours = parseFloat(body.refHours) || 0;       // годин/рейс

    // 4б. Супутні витрати (платні дороги, кордон, брокер, страховка, паром) — за рейс/ходку
    const useExtras = body.useExtras === true;
    const tollCost = useExtras ? (parseFloat(body.tollCost) || 0) * fxRate : 0;
    const borderCost = useExtras ? (parseFloat(body.borderCost) || 0) * fxRate : 0;
    const brokerCost = useExtras ? (parseFloat(body.brokerCost) || 0) * fxRate : 0;
    const greenCardCost = useExtras ? (parseFloat(body.greenCardCost) || 0) * fxRate : 0;
    const ferryCost = useExtras ? (parseFloat(body.ferryCost) || 0) * fxRate : 0;

    // 5. Накладні витрати (амортизація/фін. витрати — не VAT-товар, ремонт — VAT-товар)
    const amortYear = parseFloat(body.amort) || 0;
    const adminYear = parseFloat(body.admin) || 0;
    const otherOpYear = parseFloat(body.otherOperating) || 0;   // "Інші операційні витрати"
    const otherExpYear = parseFloat(body.otherExpenses) || 0;   // "Накладні витрати. Інші витрати"
    const repairYear = parseFloat(body.repair) || 0;
    const finYear = parseFloat(body.fin) || 0;
    const totalFleet = parseFloat(body.totalFleet);
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
    // Після розвантаження в B авто їде порожнім до C, вантаженим до D і порожнім назад в A.
    // Доступні зворотні ходки: разовий — по одній на авто (порожнього повернення в розрахунку
    // немає, тож контур — нові км); циклічний — усі ходки: наявні порожні повернення B→A
    // замінюються контуром, а останнє повернення кожного авто теж може бути завантаженим.
    // Використано = min(доступні, ceil(обсяг зворотного / норма)); неповна ходка — з фактичними тоннами.
    const isRoundTrip = body.isRoundTrip === true;
    const rtTransferDist = isRoundTrip ? (parseFloat(body.rtTransferDist) || 0) : 0;
    const rtBackhaulDist = isRoundTrip ? (parseFloat(body.rtBackhaulDist) || 0) : 0;
    const rtReturnDist = isRoundTrip ? (parseFloat(body.rtReturnDist) || 0) : 0;
    const rtTotalVolumeAvailable = isRoundTrip ? (parseFloat(body.rtTotalVolume) || 0) : 0;
    const rtRate = isRoundTrip ? ((parseFloat(body.rtRate) || 0) * fxRate) : 0;
    if (isRoundTrip) {
        const rtMissing = [
            ['rtTotalVolume', 'Обсяг зворотного вантажу', rtTotalVolumeAvailable],
            ['rtRate', 'Розцінка зворотного вантажу', rtRate],
            ['rtBackhaulDist', 'Плече C→D', rtBackhaulDist]
        ].filter((item) => !(item[2] > 0));
        if (rtMissing.length) {
            return {
                status: 400,
                code: 'MISSING_FIELDS',
                error: 'Заповніть: ' + rtMissing.map((item) => item[1]).join(', '),
                fields: rtMissing.map((item) => item[0])
            };
        }
    }

    const emptyReturnsInPlan = returnMode === 'разовий' ? 0 : Math.max(0, tripsCount - carsCount);
    const numReturnLegs = returnMode === 'разовий' ? carsCount : tripsCount;
    const legsByVolume = normWeight > 0 ? Math.ceil(rtTotalVolumeAvailable / normWeight - 1e-9) : 0;
    const rtLegsUsed = isRoundTrip ? Math.min(numReturnLegs, legsByVolume) : 0;
    const rtVolumeTotal = Math.min(rtTotalVolumeAvailable, rtLegsUsed * normWeight);
    const rtIncome = rtVolumeTotal * rtRate;

    // Дні контуру: та сама швидкість, що в основному рейсі (км з вантажем + порожні) / (ходки × діб на ходку).
    const baseRunKm = totalLoadedKm + totalEmptyKm;
    const baseRunDays = tripsCount * daysPerTrip;
    const kmPerDay = baseRunDays > 0 ? baseRunKm / baseRunDays : 0;
    const rtLoopKm = rtTransferDist + rtBackhaulDist + rtReturnDist;
    const rtReplacedLegs = Math.min(rtLegsUsed, emptyReturnsInPlan);
    const rtNewLegs = rtLegsUsed - rtReplacedLegs;
    let rtExtraKm = 0;
    if (rtLegsUsed > 0) {
        totalEmptyKm = Math.max(0, totalEmptyKm - rtReplacedLegs * dist + rtLegsUsed * (rtTransferDist + rtReturnDist));
        totalLoadedKm += rtLegsUsed * rtBackhaulDist;
        rtExtraKm = rtReplacedLegs * (rtLoopKm - dist) + rtNewLegs * rtLoopKm;
    }
    const rtExtraDays = kmPerDay > 0 ? Math.max(0, rtExtraKm / kmPerDay) : 0;

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
        if (rtLegsUsed > 0 && dist > 0) {
            refFuelCost += refFuelRate * refHours * (rtBackhaulDist / dist) * (fuelPrice / vatDivisor) * rtLegsUsed;
        }
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
    const totalTripDays = tripsCount * (daysPerTrip + idleDays) + rtExtraDays;
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
    // Дороги, кордон, зелена карта, паром прив'язані до маршруту A→B — на C→D не копіюємо.
    // Брокер (документи на партію вантажу) — на кожну завантажену зворотну ходку.
    const extrasTotal = extrasPerTrip * (returnMode === 'разовий' ? carsCount : tripsCount) + brokerCost * rtLegsUsed;

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

    // --- Точка беззбитковості: розцінка (грн/т, у тих же одиницях, що вводить користувач —
    // з ПДВ для безготівкового), при якій відповідний показник дорівнює нулю. ---
    // Дохід залежить від розцінки R: gross(R) = R*об'єм + фіксований дохід (зворотний вантаж, простій).
    // База для маржі: gross/1.2 (безготівковий) або gross. Податок ФОП = 6% від gross.
    // Якщо ЗП водія у % від фрахту — вона теж залежить від R (ЗП + ЄСВ = 1.22*pct*gross).
    const vatFactor = calcType === 'безготівковий' ? 1.2 : 1.0;
    const taxRate = calcType === 'фоп' ? 0.06 : 0;
    const driverPctK = driverPayMode === 'pct' ? 1.22 * driverPctVal / 100 : 0;
    const nonRateDirect = directCostsTotal - (driverPayMode === 'pct' ? salaryTotal + esvTotal : 0);
    const fixedIncome = rtIncome + idleCompensationTotal;

    const breakevenRate = (costBase, extraCoef) => {
        const k = 1 / vatFactor - driverPctK - extraCoef; // частка кожної гривні брудного доходу, що лишається після ПДВ/ЗП%/податку
        if (actualVolume <= 0 || k <= 0) return null;     // за такої схеми беззбитковість недосяжна
        return Math.max(0, (costBase / k - fixedIncome) / actualVolume);
    };
    const beMargin = breakevenRate(nonRateDirect, 0);
    const beEbitda = breakevenRate(nonRateDirect + ebitdaOverheadTotal, 0);
    const beFull = breakevenRate(nonRateDirect + ebitdaOverheadTotal + postEbitdaTotal, taxRate);

    const roundOrNull = v => (v === null ? null : Math.round(v));
    const breakevenMarginPerTon = roundOrNull(beMargin);
    const breakevenEbitdaPerTon = roundOrNull(beEbitda);
    const breakevenFullPerTon = roundOrNull(beFull);
    const breakevenGapPerTon = beFull === null ? null : Math.round(rate - beFull);           // >0 запас, <0 дефіцит
    const breakevenExVatPerTon = (calcType === 'безготівковий' && beFull !== null) ? Math.round(beFull / 1.2) : null;
    const rateExVatPerTon = Math.round(rate / 1.2);

    const detailedRows = [
        { name: '⛽ Пальне (ДП завантажений + порожній + подача' + (refFuelCost > 0 ? ' + реф' : '') + ')', val: Math.round(fuelTotal) },
        { name: useAdblue ? '💧 Рідина AdBlue' : '💧 Рідина AdBlue (вимкнено)', val: Math.round(adblueTotal) },
        { name: '👨‍✈️ Зарплата екіпажу + ЄСВ (22%) + Добові', val: Math.round(driverTotal) },
        { name: '🔧 ТО, Шини та Ремонти' + (tankWashTotal > 0 ? ' + промивка цистерни' : ''), val: Math.round(maintenanceTotal) },
        ...(useExtras ? [{ name: '🌍 Супутні витрати (дороги, кордон, брокер, страховка, паром)', val: Math.round(extrasTotal) }] : []),
        { name: '🏢 Накладні до EBITDA (адмін + інші операційні + інші витрати)', val: Math.round(ebitdaOverheadTotal) },
        { name: '📉 Амортизація та фінансові витрати (після EBITDA)', val: Math.round(postEbitdaTotal) },
        { name: '🏛️ Податки (ФОП / ПДВ)', val: Math.round(taxesTotal) }
    ];

    let tripVolumeText = returnMode === 'разовий'
        ? `Об'єм разового рейсу: ${actualVolume.toFixed(1)} т (${carsCount} авто по ${normWeight} т)`
        : `Об'єм вивозу: ${tripsCount} ходок (${actualVolume} т)`;

    // Чесна підказка, якщо зворотного вантажу більше, ніж можна довезти цими авто.
    const rtWarning = isRoundTrip && rtTotalVolumeAvailable - rtVolumeTotal > 0.0005
        ? `Зворотний вантаж: враховано ${formatCalcTons(rtVolumeTotal)} з ${formatCalcTons(rtTotalVolumeAvailable)} т — на решту не вистачає авто`
        : '';

    if (isRoundTrip) {
        tripVolumeText += ` | 🔄 Кругорейс: ${rtLegsUsed} з ${numReturnLegs} зворотних ходок (${formatCalcTons(rtVolumeTotal)} т)`;
        if (rtWarning) tripVolumeText += ' | ⚠️ ' + rtWarning;
    }

    // Без кругорейсу текст лишається колишнім (golden-результати не змінюються).
    const rtInfoText = isRoundTrip
        ? `Зворотних ходок: ${rtLegsUsed} з ${numReturnLegs} доступних, ${formatCalcTons(rtVolumeTotal)} т` + (rtWarning ? ' | ⚠️ ' + rtWarning : '')
        : (emptyReturnsInPlan > 0 ? `Доступно зворотних ходок: ${emptyReturnsInPlan} | Використано: 0 (обмежено обсягом вантажу)` : '');

    const podachaText = totalPodachaKm > 0
        ? `Витрати на подачу: ${Math.round(fuelPodachaCost)} грн (${totalPodachaKm} км)`
        : '';

    const fuelSummaryText = `⛽ Пальне: заг. пробіг ${totalAllKm} км | Витрати: ${Math.round(fuelTotal)} грн`;
    const adblueSummaryText = useAdblue
        ? `💧 AdBlue: витрати ${Math.round(adblueTotal)} грн`
        : '💧 AdBlue: не використовується';

    return {
        public: {
            contractCurrency,
            fxRate,
            grossIncome: Math.round(grossIncome),
            netIncome: Math.round(netIncome),
            marginalIncome: Math.round(marginalIncome),
            marginPerTon: actualVolume > 0 ? Math.round(marginalIncome / actualVolume) : 0,
            ebitda: Math.round(ebitda),
            ebitdaPerTon: actualVolume > 0 ? Math.round(ebitda / actualVolume) : 0,
            netProfit: Math.round(netProfit),
            profitabilityPct,
            breakevenMarginPerTon,
            breakevenEbitdaPerTon,
            breakevenFullPerTon,
            breakevenGapPerTon,
            breakevenExVatPerTon,
            rateExVatPerTon,
            fuelAndAdblueTotal: Math.round(fuelTotal + adblueTotal),
            driverTotal: Math.round(driverTotal),
            toTotal: Math.round(maintenanceTotal),
            extrasTotal: Math.round(extrasTotal),
            overheadTotal: Math.round(overheadTotal),
            taxesTotal: Math.round(taxesTotal),
            detailedRows,
            warnings: emptyCostWarnings(body),

            tripVolumeText,
            rtInfoText,
            ...(isRoundTrip ? { rtWarning } : {}),
            podachaText,
            fuelSummaryText,
            adblueSummaryText
        },
        raw: {
            rtVolumeTotal,
            rtVolumeAvailable: rtTotalVolumeAvailable,
            marginalIncome,
            ebitda,
            postEbitdaTotal
        }
    };
}

const VEHICLE_TRAILERS = ['зерновоз', 'рефрижератор', 'тент', 'цистерна'];

function formatCalcTons(value) {
    const n = Math.round(Number(value) * 1000) / 1000;
    return Number.isFinite(n) ? String(n) : '0';
}

function positiveCalcNumber(value) {
    const n = Number(value);
    return n > 0 ? n : null;
}

// Тонни в тисячних: остання частка забирає залишок, тож сума дорівнює обсягу.
export function splitTonnageShares(totalTons, weights) {
    const count = Array.isArray(weights) ? weights.length : 0;
    const total = Math.round(Number(totalTons) * 1000);
    if (!(count > 0) || !(total > 0)) return [];
    const clean = weights.map(function (weight) {
        const n = Number(weight);
        return n > 0 ? n : 0;
    });
    const sumWeights = clean.reduce(function (sum, n) { return sum + n; }, 0);
    const even = !(sumWeights > 0);
    const shares = [];
    let used = 0;
    for (let i = 0; i < count; i++) {
        if (i === count - 1) {
            shares.push((total - used) / 1000);
            break;
        }
        const share = even
            ? Math.floor(total / count)
            : Math.floor(total * clean[i] / sumWeights);
        used += share;
        shares.push(share / 1000);
    }
    return shares;
}

function vehicleSlicePayload(base, assignment, rtShare) {
    const slice = {};
    Object.keys(base || {}).forEach(function (key) {
        if (key !== 'vehicles' && key !== 'vehicleSplitMode') slice[key] = base[key];
    });
    slice.carsCount = 1;
    const tons = Number(assignment.tonnage);
    if (String(slice.returnMode) === 'разовий') slice.normWeight = tons;
    else slice.volume = tons;
    const fuelLoad = positiveCalcNumber(assignment.fuelLoad);
    const fuelEmpty = positiveCalcNumber(assignment.fuelEmpty);
    if (fuelLoad !== null) slice.fuelLoad = fuelLoad;
    if (fuelEmpty !== null) slice.fuelEmpty = fuelEmpty;
    if (assignment.useAdblue === false) {
        slice.useAdblue = false;
        slice.adblueConsumption = 0;
    } else if (assignment.useAdblue === true) {
        slice.useAdblue = true;
        const rate = positiveCalcNumber(assignment.adblueConsumption);
        if (rate !== null) slice.adblueConsumption = rate;
    }
    if (VEHICLE_TRAILERS.indexOf(assignment.trailerType) >= 0) slice.trailerType = assignment.trailerType;
    if (String(slice.returnMode) !== 'разовий') {
        const capacity = positiveCalcNumber(assignment.payloadTons);
        if (capacity !== null) slice.normWeight = capacity;
    }
    // Зворотний вантаж ділиться між авто (див. sumVehicleTrips), а не дається кожному повністю.
    if (slice.isRoundTrip === true && rtShare !== undefined) {
        if (rtShare > 0) slice.rtTotalVolume = rtShare;
        else slice.isRoundTrip = false; // цьому авто зворотного вантажу не дісталось
    }
    return slice;
}

function vehicleRowValue(result, needle) {
    return (result.detailedRows || [])
        .filter(function (row) { return String(row.name).indexOf(needle) !== -1; })
        .reduce(function (sum, row) { return sum + row.val; }, 0);
}

function weightedVehicleRate(parts, key) {
    if (parts.some(function (part) { return part.result[key] === null || part.result[key] === undefined; })) return null;
    const weight = parts.reduce(function (sum, part) { return sum + Number(part.assignment.tonnage); }, 0);
    if (!(weight > 0)) return null;
    const acc = parts.reduce(function (sum, part) { return sum + part.result[key] * Number(part.assignment.tonnage); }, 0);
    return Math.round(acc / weight);
}

// Кожне авто — окремий розрахунок. Одне авто лишає округлення calculateTrip.
// Для двох і більше маржа, EBITDA й амортизація сумуються з незаокруглених
// часток і округлюються один раз, тож EBITDA − податок − амортизація = прибуток.
// Останній рядок розбивки підганяється під цей підсумок.
// Порожній список сюди не приходить: рейс без авто лишає calculateTrip без змін.
export function sumVehicleTrips(base, assignments) {
    if (!Array.isArray(assignments) || !assignments.length) return null;
    const rtShares = base && base.isRoundTrip === true
        ? splitTonnageShares(parseFloat(base.rtTotalVolume) || 0, assignments.map(function (a) { return Number(a.tonnage); }))
        : [];
    const parts = assignments.map(function (assignment, index) {
        const payload = vehicleSlicePayload(base, assignment, base && base.isRoundTrip === true ? (rtShares[index] || 0) : undefined);
        const computed = computeTrip(payload);
        if (computed && computed.status) {
            return { assignment: assignment, payload: payload, result: computed, raw: null };
        }
        return { assignment: assignment, payload: payload, result: computed.public, raw: computed.raw };
    });
    const failed = parts.find(function (part) { return part.result && part.result.status; });
    if (failed) return failed.result;

    const moneyKeys = ['grossIncome', 'netIncome', 'marginalIncome', 'ebitda', 'netProfit', 'fuelAndAdblueTotal', 'driverTotal', 'toTotal', 'extrasTotal', 'overheadTotal', 'taxesTotal'];
    const combined = {
        contractCurrency: parts[0].result.contractCurrency,
        fxRate: parts[0].result.fxRate
    };
    moneyKeys.forEach(function (key) {
        combined[key] = parts.reduce(function (sum, part) { return sum + part.result[key]; }, 0);
    });
    const assigned = parts.reduce(function (sum, part) { return sum + Number(part.assignment.tonnage); }, 0);
    combined.assignedTonnage = Math.round(assigned * 1000) / 1000;
    combined.marginPerTon = assigned > 0 ? Math.round(combined.marginalIncome / assigned) : 0;
    combined.ebitdaPerTon = assigned > 0 ? Math.round(combined.ebitda / assigned) : 0;
    combined.breakevenMarginPerTon = weightedVehicleRate(parts, 'breakevenMarginPerTon');
    combined.breakevenEbitdaPerTon = weightedVehicleRate(parts, 'breakevenEbitdaPerTon');
    combined.breakevenFullPerTon = weightedVehicleRate(parts, 'breakevenFullPerTon');
    combined.breakevenGapPerTon = weightedVehicleRate(parts, 'breakevenGapPerTon');
    combined.breakevenExVatPerTon = weightedVehicleRate(parts, 'breakevenExVatPerTon');
    combined.rateExVatPerTon = parts[0].result.rateExVatPerTon;

    const rowOrder = [];
    const rowValues = {};
    parts.forEach(function (part) {
        (part.result.detailedRows || []).forEach(function (row) {
            if (!Object.prototype.hasOwnProperty.call(rowValues, row.name)) {
                rowValues[row.name] = 0;
                rowOrder.push(row.name);
            }
            rowValues[row.name] += row.val;
        });
    });
    const warningKeys = {};
    combined.warnings = [];
    parts.forEach(function (part) {
        (part.result.warnings || []).forEach(function (item) {
            if (warningKeys[item.key]) return;
            warningKeys[item.key] = true;
            combined.warnings.push(item);
        });
    });
    combined.detailedRows = rowOrder.map(function (name) { return { name: name, val: rowValues[name] }; });
    let breakdownProfitAdjust = 0;
    let breakdownCostAdjust = 0;
    if (parts.length >= 2) {
        const rawMargin = parts.reduce(function (sum, part) { return sum + part.raw.marginalIncome; }, 0);
        const rawEbitda = parts.reduce(function (sum, part) { return sum + part.raw.ebitda; }, 0);
        const rawAmort = parts.reduce(function (sum, part) { return sum + part.raw.postEbitdaTotal; }, 0);
        combined.marginalIncome = Math.round(rawMargin);
        combined.ebitda = Math.round(rawEbitda);
        const amort = Math.round(rawAmort);
        const summedAmort = vehicleRowValue(combined, 'Амортизація');
        combined.detailedRows.forEach(function (row) {
            if (String(row.name).indexOf('Амортизація') !== -1) row.val = amort;
        });
        combined.marginPerTon = assigned > 0 ? Math.round(combined.marginalIncome / assigned) : 0;
        combined.ebitdaPerTon = assigned > 0 ? Math.round(combined.ebitda / assigned) : 0;
        const summedNet = combined.netProfit;
        let fleetTaxDelta = 0;
        if (String(base && base.calcType) === 'фоп') {
            const onceTax = Math.round(combined.grossIncome * 0.06);
            fleetTaxDelta = onceTax - combined.taxesTotal;
            combined.taxesTotal = onceTax;
            combined.detailedRows.forEach(function (row) {
                if (String(row.name).indexOf('Податки') !== -1) row.val = onceTax;
            });
        }
        combined.netProfit = combined.ebitda - combined.taxesTotal - amort;
        breakdownProfitAdjust = combined.netProfit - summedNet;
        breakdownCostAdjust = (amort - summedAmort) + fleetTaxDelta;
    }
    combined.profitabilityPct = combined.netIncome > 0 ? (combined.netProfit / combined.netIncome) * 100 : 0;

    const labels = parts.map(function (part) {
        return (part.assignment.label || 'Авто') + ' ' + formatCalcTons(part.assignment.tonnage) + ' т';
    });
    combined.tripVolumeText = 'По авто: ' + labels.join(' · ') + ' | разом ' + formatCalcTons(assigned) + ' т';
    const contractVolume = parseFloat(base && base.volume);
    if (String(base && base.returnMode) !== 'разовий' && contractVolume > 0 && Math.abs(contractVolume - assigned) > 0.0005) {
        combined.tripVolumeText += ' | розкладено ' + formatCalcTons(assigned) + ' з ' + formatCalcTons(contractVolume) + ' т';
    }
    combined.rtInfoText = parts.map(function (part) { return part.result.rtInfoText; }).filter(Boolean).join(' | ');
    if (base && base.isRoundTrip === true) {
        combined.rtWarning = '';
        const rtUsed = parts.reduce(function (sum, part) { return sum + (part.raw ? part.raw.rtVolumeTotal : 0); }, 0);
        const rtAll = parseFloat(base.rtTotalVolume) || 0;
        combined.tripVolumeText += ' | 🔄 Кругорейс: ' + formatCalcTons(rtUsed) + ' т';
        if (rtAll - rtUsed > 0.0005) {
            combined.rtWarning = 'Зворотний вантаж: враховано ' + formatCalcTons(rtUsed) + ' з ' + formatCalcTons(rtAll) + ' т — на решту не вистачає авто';
            combined.tripVolumeText += ' | ⚠️ ' + combined.rtWarning;
        }
    }
    combined.podachaText = parts.map(function (part) { return part.result.podachaText; }).filter(Boolean).join(' · ');
    const diesel = vehicleRowValue(combined, 'Пальне');
    const adblue = vehicleRowValue(combined, 'AdBlue');
    const km = parts.reduce(function (sum, part) {
        const text = String(part.result.fuelSummaryText || '');
        const match = text.match(/(\d+)\s*км/);
        return sum + (match ? Number(match[1]) : 0);
    }, 0);
    combined.fuelSummaryText = '⛽ Пальне: ' + parts.length + ' авто, пробіг ' + km + ' км | Витрати: ' + diesel + ' грн';
    combined.adblueSummaryText = adblue > 0
        ? '💧 AdBlue: витрати ' + adblue + ' грн'
        : '💧 AdBlue: не використовується';

    combined.vehicleBreakdown = parts.map(function (part, index) {
        const fuel = vehicleRowValue(part.result, 'Пальне');
        const adblueCost = vehicleRowValue(part.result, 'AdBlue');
        const costAdjust = index === parts.length - 1 ? breakdownCostAdjust : 0;
        const profitAdjust = index === parts.length - 1 ? breakdownProfitAdjust : 0;
        const costs = (part.result.detailedRows || []).reduce(function (sum, row) {
            if (String(row.name).indexOf('Пальне') !== -1 || String(row.name).indexOf('AdBlue') !== -1) return sum;
            return sum + row.val;
        }, 0) + costAdjust;
        return {
            id: part.assignment.id || null,
            label: part.assignment.label || 'Авто',
            tonnage: Number(part.assignment.tonnage),
            fuel: fuel,
            adblue: adblueCost,
            costs: costs,
            profit: part.result.netProfit + profitAdjust
        };
    });
    return combined;
}

function vehicleAssignmentsFromBody(body) {
    const raw = body && body.vehicles;
    if (!Array.isArray(raw) || !raw.length) return null;
    const list = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (!item || typeof item !== 'object' || !(Number(item.tonnage) > 0)) {
            return {
                error: {
                    status: 400,
                    code: 'BAD_TONNAGE',
                    error: 'Вкажи тоннаж кожного обраного авто.'
                }
            };
        }
        list.push(item);
    }
    return { list: list };
}

// Обов'язкові поля: без них результат був би вигаданим. Разовий рейс: «Обсяг» не потрібен
// (обсяг = норма × авто). Увімкнений кругорейс: обсяг і розцінка зворотного вантажу та плече C→D.
export const REQUIRED_FIELD_LABELS = {
    dist: 'Відстань', volume: 'Обсяг', normWeight: 'Норма завантаження', carsCount: 'Кількість авто',
    daysPerTrip: 'Днів на рейс', rate: 'Ставка', fuelLoad: 'Витрата з вантажем', fuelEmpty: 'Витрата порожнім',
    fuelPrice: 'Ціна палива', totalFleet: 'Авто в парку', toPeriod: 'Пробіг між ТО', tireMileage: 'Ресурс шин',
    rtTotalVolume: 'Обсяг зворотного вантажу', rtRate: 'Розцінка зворотного вантажу', rtBackhaulDist: 'Плече C→D'
};
const BASE_REQUIRED = ['dist', 'volume', 'normWeight', 'carsCount', 'daysPerTrip', 'rate', 'fuelLoad', 'fuelEmpty',
    'fuelPrice', 'totalFleet', 'toPeriod', 'tireMileage'];
const ROUND_TRIP_REQUIRED = ['rtTotalVolume', 'rtRate', 'rtBackhaulDist'];

export function missingRequiredFields(body) {
    const b = body || {};
    const isOneOff = b.returnMode === 'разовий';
    const keys = BASE_REQUIRED.filter((k) => !(isOneOff && k === 'volume'));
    if (b.isRoundTrip === true) keys.push(...ROUND_TRIP_REQUIRED);
    return keys.filter((k) => !(parseFloat(b[k]) > 0));
}

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
        if (userIsBlocked(user)) {
            return res.status(403).json(USER_BLOCKED_ERROR);
        }
        const { data: profile } = await supabase
            .from('profiles')
            .select('is_approved, org_id, member_status, organizations(status)')
            .eq('id', user.id)
            .single();
        if (!profile || !profile.org_id) {
            return res.status(403).json({ code: 'NO_PROFILE', error: 'Профіль користувача не знайдено.' });
        }
        if (profile.member_status === 'disabled') {
            return res.status(403).json({ code: 'MEMBER_DISABLED', error: 'Доступ до компанії відключено.' });
        }
        if (!profile.organizations || profile.organizations.status === 'blocked') {
            return res.status(403).json({ code: 'ORG_BLOCKED', error: 'Доступ компанії заблоковано адміністратором.' });
        }

        // --- Обов'язкові поля: без них результат був би вигаданим, тому відхиляємо ДО зарахування в ліміт демо ---
        const reqBody = req.body || {};
        const missingFields = missingRequiredFields(reqBody);
        if (missingFields.length) {
            return res.status(400).json({
                code: 'MISSING_FIELDS',
                error: 'Заповніть: ' + missingFields.map(k => REQUIRED_FIELD_LABELS[k]).join(', '),
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

        const vehicleSplit = vehicleAssignmentsFromBody(reqBody);
        if (vehicleSplit && vehicleSplit.error) {
            return res.status(vehicleSplit.error.status).json({
                code: vehicleSplit.error.code,
                error: vehicleSplit.error.error
            });
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

        const computed = vehicleSplit
            ? sumVehicleTrips(req.body || {}, vehicleSplit.list)
            : calculateTrip(req.body || {});
        if (computed.status) {
            return res.status(computed.status).json({ code: computed.code, error: computed.error });
        }
        return res.status(200).json({
            demo: demoInfo, // null для повного доступу, {used, limit} для демо
            ...computed
        });

    } catch (err) {
        console.error('Calculation error:', err);
        return res.status(500).json({ error: err.message });
    }
}
