# Скріншоти для Microsoft Store (1920×1080)

Файли `store-overview.png`, `store-calculations.png`, `store-clients.png`, `store-documents.png` знімає
`scripts/store-screenshots.mjs` у цю теку. Без входу в акаунт їх не зняти, тому в репозиторії лише скрипт; PNG з’являться після запуску.

```bash
cd apps/kontrol-plus
npm i --no-save playwright && npx playwright install chromium   # власний Chromium, не системний Chrome
node scripts/store-screenshots.mjs --login                      # один раз: увійти вручну, натиснути Enter
node scripts/store-screenshots.mjs                              # знімає 4 PNG у store-screenshots/ (поза public/, у .gitignore)
```

- За замовчуванням база — `https://app.trip-control.com`; інша: `--base <url>` або `KP_BASE_URL`.
- Сесія зберігається у `apps/kontrol-plus/.store-session.json` (шлях можна змінити через `KP_STORAGE_STATE`).
  Це токени входу — файл не комітити.
- Знімайте демо-акаунт без реальних клієнтів і номерів. Перед завантаженням у Partner Center перегляньте PNG.
- PNG містять реальні дані акаунта, тому лежать поза `public/` (не потраплять у dist) і ігноруються git. Не комітити; у маніфест не підключені.
