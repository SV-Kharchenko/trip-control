export default function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const data = req.body;

        const calcType = data.calcType || 'фоп';
        const returnMode = data.returnMode || 'циклічний';
        const roadQuality = parseFloat(data.roadQuality) || 1.0;
        const trailerType = data.trailerType || 'зерновоз';

        const dist = parseFloat(data.dist) || 0;
        const podachaDist = parseFloat(data.podachaDist) || 0;
        const contractVolume = parseFloat(data.volume) || 0;
        const normWeight = parseFloat(data.normWeight) || 1;
        const carsCount = parseFloat(data.carsCount) || 1;
        const daysPerTrip = parseFloat(data.daysPerTrip) || 1;
        const idleDays = parseFloat(data.idleDays) || 0;
        const idleRate = parseFloat(data.idleRate) || 0;
        const rate = parseFloat(data.rate) || 0;

        let actualVolume = 0;
        let tripsCount = 0;
        let totalLoadedKm = 0;
        let totalEmptyKm = 0;

        if (returnMode === 'разовий') {
            tripsCount = carsCount;
            actualVolume = normWeight * carsCount;
            totalLoadedKm = dist * carsCount;
            totalEmptyKm = 0;
        } else {
            tripsCount = contractVolume / normWeight;
            actualVolume = contractVolume;
            totalLoadedKm = dist * tripsCount;
            totalEmptyKm = dist * Math.max(0, tripsCount - carsCount);
        }

        const season = data.season || 'стандарт';
        let seasonCoeff = 1.0;
        if (season === 'літо') seasonCoeff = 1.05;
        else if (season === 'зима') seasonCoeff = 1.10;

        const fuelLoad = (parseFloat(data.fuelLoad) || 0) * seasonCoeff * roadQuality;
        const fuelEmpty = (parseFloat(data.fuelEmpty) || 0) * seasonCoeff * roadQuality;
        const fuelPrice = parseFloat(data.fuelPrice) || 0;

        const driverPayMode = data.driverPayMode || 'km';
        const driverRateLoad = parseFloat(data.driverRateLoad) || 0;
        const driverRateEmpty = parseFloat(data.driverRateEmpty) || 0;
        const driverPctVal = parseFloat(data.driverPctVal) || 0;
        const perDiem = parseFloat(data.perDiem) || 0;

        const toCost = (parseFloat(data.toCost) || 0) * (1 + (roadQuality - 1) * 0.5);
        const toPeriod = parseFloat(data.toPeriod) || 1;
        const tireCost = (parseFloat(data.tireCost) || 0) * (1 + (roadQuality - 1) * 0.5);
        const tireCount = parseFloat(data.tireCount) || 0;
        const tireMileage = parseFloat(data.tireMileage) || 1;
        const adbluePrice = parseFloat(data.adbluePrice) || 0;
        const adblueConsumption = parseFloat(data.adblueConsumption) || 0;

        const washCost = parseFloat(data.washCost) || 0;
        const washFreq = parseFloat(data.washFreq) || 0;
        const refFuelRate = parseFloat(data.refFuelRate) || 0;
        const refHours = parseFloat(data.refHours) || 0;

        const amort = parseFloat(data.amort) || 0;
        const admin = parseFloat(data.admin) || 0;
        const repair = parseFloat(data.repair) || 0;
        const fin = parseFloat(data.fin) || 0;
        const totalFleet = parseFloat(data.totalFleet) || 1;

        const totalPodachaKm = podachaDist * carsCount;

        const isRoundTrip = data.isRoundTrip === true;
        const rtTransferDist = isRoundTrip ? (parseFloat(data.rtTransferDist) || 0) : 0;
        const rtBackhaulDist = isRoundTrip ? (parseFloat(data.rtBackhaulDist) || 0) : 0;
        const rtReturnDist = isRoundTrip ? (parseFloat(data.rtReturnDist) || 0) : 0;
        const rtTotalVolumeAvailable = isRoundTrip ? (parseFloat(data.rtTotalVolume) || 0) : 0;
        const rtRate = isRoundTrip ? (parseFloat(data.rtRate) || 0) : 0;

        const numReturnLegs = (returnMode === 'разовий') ? 0 : Math.max(0, Math.round(tripsCount - carsCount));
        const maxLegsByCapacity = normWeight > 0 ? Math.floor(rtTotalVolumeAvailable / normWeight) : 0;
        const rtLegsUsed = isRoundTrip ? Math.min(numReturnLegs, maxLegsByCapacity) : 0;
        const rtVolumeTotal = Math.min(rtTotalVolumeAvailable, rtLegsUsed * normWeight);
        const rtIncome = rtVolumeTotal * rtRate;

        if (rtLegsUsed > 0) {
            totalEmptyKm = Math.max(0, totalEmptyKm - rtLegsUsed * dist + rtLegsUsed * (rtTransferDist + rtReturnDist));
            totalLoadedKm += rtLegsUsed * rtBackhaulDist;
        }

        const fuelCostEmptyPerKm = (fuelEmpty * fuelPrice) / 100 / (calcType === 'безготівковий' ? 1.2 : 1.0);
        const podachaLitres = (fuelEmpty * totalPodachaKm) / 100;
        const fuelPodachaTotal = fuelCostEmptyPerKm * totalPodachaKm;

        const fuelLoadedTotal = ((fuelPrice * fuelLoad) / 100 / (calcType === 'безготівковий' ? 1.2 : 1.0)) * totalLoadedKm;
        const fuelEmptyTotal = fuelCostEmptyPerKm * totalEmptyKm;
        
        let refFuelTotal = 0;
        if (trailerType === 'рефрижератор') {
            refFuelTotal = (refFuelRate * refHours * (fuelPrice / (calcType === 'безготівковий' ? 1.2 : 1.0))) * (returnMode === 'разовий' ? carsCount : tripsCount);
        }

        const fuelTotal = fuelLoadedTotal + fuelEmptyTotal + refFuelTotal + fuelPodachaTotal;
        const adblueTotal = ((adbluePrice * adblueConsumption / 100) / (calcType === 'безготівковий' ? 1.2 : 1.0)) * (totalLoadedKm + totalEmptyKm + totalPodachaKm);

        const idleCompensationTotal = idleDays * idleRate * (returnMode === 'разовий' ? carsCount : tripsCount);
        const grossIncome = (rate * actualVolume) + rtIncome + idleCompensationTotal;

        let tax5Total = 0;
        let tax1Total = 0;
        let netIncome = grossIncome;

        if (calcType === 'безготівковий') {
            netIncome = grossIncome / 1.2;
        } else if (calcType === 'фоп') {
            tax5Total = grossIncome * 0.05;
            tax1Total = grossIncome * 0.01;
            netIncome = grossIncome - tax5Total - tax1Total;
        }

        let driverTotal = 0;
        if (driverPayMode === 'km') {
            driverTotal = (driverRateLoad * totalLoadedKm) + (driverRateEmpty * totalEmptyKm) + (driverRateEmpty * totalPodachaKm);
        } else {
            driverTotal = grossIncome * (driverPctVal / 100);
        }

        const esvTotal = driverTotal * 0.22;
        const actualTripDays = (daysPerTrip + idleDays) * (returnMode === 'разовий' ? 1 : (tripsCount / carsCount));
        const perDiemTotal = perDiem * actualTripDays * carsCount;

        const totalMileageAll = totalLoadedKm + totalEmptyKm + totalPodachaKm;
        const toTotal = ((toCost / toPeriod) / (calcType === 'безготівковий' ? 1.2 : 1.0)) * totalMileageAll;
        const tireTotal = (((tireCost * tireCount) / tireMileage) / (calcType === 'безготівковий' ? 1.2 : 1.0)) * totalMileageAll;

        const directCosts = fuelTotal + adblueTotal + driverTotal + esvTotal + perDiemTotal + toTotal + tireTotal;
        const marginalIncome = netIncome - directCosts;

        const annualTankWashTotal = trailerType === 'цистерна' ? (washCost * washFreq) * totalFleet : 0;
        const dailyOverheadAdminRepair = (admin + repair + (annualTankWashTotal / (calcType === 'безготівковий' ? 1.2 : 1.0))) / totalFleet / 365;
        const dailyOverheadAmortFin = (amort + fin) / totalFleet / 365;

        const adminRepairAllocated = dailyOverheadAdminRepair * actualTripDays * carsCount;
        const amortFinAllocated = dailyOverheadAmortFin * actualTripDays * carsCount;

        const ebitda = marginalIncome - adminRepairAllocated;
        const netProfit = ebitda - amortFinAllocated;
        const profitabilityPct = netIncome > 0 ? (netProfit / netIncome) * 100 : 0;
        const safeVolume = actualVolume > 0 ? actualVolume : 1;

        return res.status(200).json({
            grossIncome,
            netIncome,
            marginalIncome,
            ebitda,
            netProfit,
            profitabilityPct,
            marginPerTon: Math.round(marginalIncome / safeVolume),
            ebitdaPerTon: Math.round(ebitda / safeVolume),
            fuelTotal,
            driverTotal,
            toTotal,
            tireTotal,
            overheadTotal: adminRepairAllocated + amortFinAllocated,
            taxesTotal: tax5Total + tax1Total
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
