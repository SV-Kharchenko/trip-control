// Фільтр статусів «Документів»: у кожної вкладки — лише ті статуси, що реально бувають у цього виду. На «Усі» — лише спільні для всіх
// видів (анульовано). Значення збігаються з p_status відповідних RPC (kp_doc_list, kp_ttn_list, kp_trip_sheet_list,
// kp_contract_list_all, kp_other_list).
const ALL = ['', 'Усі статуси'];
const CANCELLED = ['cancelled', 'Анульовано'];

export const TAB_STATUS_OPTIONS = {
    all: [ALL, CANCELLED],
    ttn: [ALL, ['issued', 'Виставлено'], CANCELLED],
    acts: [ALL, ['issued', 'Активні'], CANCELLED],
    invoices: [ALL, ['unpaid', 'Неоплачені'], ['issued', 'Виставлено'], ['partial', 'Частково оплачено'], ['paid', 'Оплачено'], ['overdue', 'Прострочено'], CANCELLED],
    trip_sheets: [ALL, ['issued', 'Видано'], ['closed', 'Закрито'], CANCELLED],
    contracts: [ALL, ['active', 'Діє'], ['expired', 'Закінчився'], CANCELLED],
    other: [ALL, ['active', 'Діє'], ['expired', 'Закінчився'], CANCELLED],
};

export function statusOptions(tab) {
    return TAB_STATUS_OPTIONS[tab || 'all'] || TAB_STATUS_OPTIONS.all;
}

export function statusAllowed(tab, value) {
    return statusOptions(tab).some(([v]) => v === (value || ''));
}

// Бейдж строку дії договору / документа з рядка kp_contract_list_all / kp_other_list.
export function validityBadge(row) {
    if (row.status === 'cancelled') return { key: 'cancelled', label: 'Анульовано' };
    if (row.expired) return { key: 'overdue', label: 'Закінчився' };
    if (row.expiring_soon) return { key: 'partial', label: 'Закінчується за 30 днів' };
    return { key: 'issued', label: 'Діє' };
}
