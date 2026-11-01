# Скріншоти для Microsoft Store (1920×1080)

Файли `store-overview.png`, `store-calculations.png`, `store-clients.png`, `store-documents.png` знімає
`scripts/store-screenshots.mjs`. Без входу в акаунт їх не зняти, тому в репозиторії лише скрипт; PNG з’являться після запуску.

```bash
cd apps/kontrol-plus
npm i --no-save playwright && npx playwright install chromium   # власний Chromium, не системний Chrome
node scripts/store-screenshots.mjs --login                      # один раз: увійти вручну, натиснути Enter
node scripts/store-screenshots.mjs                              # знімає 4 PNG сюди
```

- За замовчуванням база — `https://app.trip-control.com`; інша: `--base <url>` або `KP_BASE_URL`.
- Сесія зберігається у `apps/kontrol-plus/.store-session.json` (шлях можна змінити через `KP_STORAGE_STATE`).
  Це токени входу — файл не комітити.
- Знімайте демо-акаунт без реальних клієнтів і номерів. Перед завантаженням у Partner Center перегляньте PNG.
- Файли `store-*.png` не підключені в маніфест: це скріни для картки в Store, а не для PWA-встановлення.
