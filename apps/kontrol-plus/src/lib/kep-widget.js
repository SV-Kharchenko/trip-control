// КЕП: каркас віджета підпису. Працює вже зараз лише шлях «id.gov.ua/sign → .p7s → завантажити» (див. views/contracts.js).
// Віджет, що вбудовується в сторінку, потребує реєстрації на боці id.gov.ua / ІІТ і документації протоколу — їх у цьому
// репозиторії немає, тому протокол обміну НЕ вигадується: після отримання доступу реалізується лише openKepWidget нижче
// (підписати байти файлу → відокремлений CAdES .p7s). Кроки — docs/CONTRACTS-KEP.md. Адресу віджета дає сервер
// (GET /api/contracts/sign → kep.widget_url з env KEP_WIDGET_URL); без неї кнопки віджета немає.

export function kepWidgetReady(config) {
    return Boolean(config && config.widget_url && config.widget_origin);
}

// → Promise<Uint8Array> з .p7s. Поки протокол віджета не підключено — зрозуміла відмова без падіння.
export async function openKepWidget(config) {
    if (!kepWidgetReady(config)) throw new Error('КЕП-віджет не налаштовано.');
    throw new Error('КЕП-віджет ще не підключено: потрібна реєстрація на id.gov.ua і протокол віджета (docs/CONTRACTS-KEP.md). Підпишіть файл на id.gov.ua/sign і завантажте .p7s.');
}
