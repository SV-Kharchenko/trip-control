# Google Maps API key — обмеження (тиждень 1)

Ключ зараз завантажується лише для **схвалених** акаунтів (`loadGoogleMaps` у `index.html`). Демо не створює платних Places/Directions запитів з браузера. Обмеження ключа в Google Cloud — обов’язкові: без них ключ з HTML можна вкрасти й спамити квоту.

## Ручні кроки в Google Cloud Console

1. **APIs & Services → Credentials** → відкрийте ключ, що в `index.html`.
2. **Application restrictions → HTTP referrers (web sites)** — дозвольте лише ваші домени, наприклад:
   - `https://YOUR-PROD-DOMAIN/*`
   - `https://*.vercel.app/*` (якщо потрібні preview-деплої; краще окремий ключ)
   - для локальної розробки: `http://localhost:*/*`, `http://127.0.0.1:*/*`
3. **API restrictions → Restrict key** — лише потрібні API:
   - Maps JavaScript API
   - Places API (New) / Places API (залежно від віджета)
   - Directions API / Routes API (якщо використовуєте)
   - Geometry Library йде з Maps JS (окремо не обмежується)
4. **Окремий ключ для prod** — не той самий, що для localhost / staging.
5. **Billing → Budgets & alerts** — алерт на витрати Maps; за бажанням квоти на API (Quotas).
6. Якщо ключ уже світився в публічному репо — **ротація** (новий ключ → оновити `index.html` / env → вимкнути старий).

## Наступний крок (тиждень 2+, не ламає поточний Maps)

Проксі Places/Directions через Edge Function з серверним ключом без `HTTP referrer`, щоб ключ не був у браузері. Поки що клієнтський ключ з жорсткими referrer/API restrictions — мінімально прийнятний варіант.
