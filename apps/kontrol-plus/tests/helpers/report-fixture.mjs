// Жовтень: 7 рейсів, 2 з фактом (без node-імпортів — вантажиться й у браузері).
// Жовтневий приклад: 7 рейсів, 2 з фактом. База «з фактом»: план −19 379, факт −50 510, відхилення −31 131 (−160,6%).
export const OCT = [
    { group_key: 'a', group_label: 'Логіст А', trips: 3, trips_with_fact: 1, plan_revenue: 150000, plan_costs: 50000, plan_profit: 100000, fact_revenue: 80000, fact_costs: 110000,
        fact_profit: -30000, plan_profit_with_fact: -9379, deviation_profit: -20621, deviation_pct: -219.9 },
    { group_key: 'b', group_label: 'Логіст Б', trips: 2, trips_with_fact: 1, plan_revenue: 90000, plan_costs: 30000, plan_profit: 60000, fact_revenue: 50000, fact_costs: 70510,
        fact_profit: -20510, plan_profit_with_fact: -10000, deviation_profit: -10510, deviation_pct: -105.1 },
    { group_key: 'c', group_label: 'Логіст В', trips: 2, trips_with_fact: 0, plan_revenue: 40000, plan_costs: 17269, plan_profit: 22731, fact_revenue: 0, fact_costs: 0,
        fact_profit: 0, plan_profit_with_fact: 0, deviation_profit: 0, deviation_pct: null },
];
