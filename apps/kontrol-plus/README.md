# Контроль+

`app.trip-control.com`: увесь функціонал trip-control.com (калькулятор, «Огляд», історія й шаблони, PDF/Excel, Viber/Telegram,
кабінет, компанія, команда, автопарк, тариф, довідка, ролі, курси валют) + CRM-вкладки «Клієнти» і «Звіт план/факт».
Та сама база й ті самі акаунти Supabase. Окремий Vercel-проєкт (Root Directory = `apps/kontrol-plus`).

## Як зроблено (сайт не змінюється)

- `scripts/sync-site.mjs` (prebuild / predev) копіює з кореня репо `index.html`, `assets/**`, `legal/**`, іконки
  у `.site/` байт у байт (у git не потрапляє). Корінь лише читається.
- Збірка (`vite.config.js`) кладе сайт у `dist/` як є; лише `dist/index.html` отримує вставки між `<!--kp:start-->` /
  `<!--kp:end-->` (`scripts/site-html.mjs`): `noindex`, стилі CRM, `/kp-entry.js` (гість одразу бачить вхід, не лендинг),
  модуль `src/site-bridge.js`, маніфест застосунку замість `/site.webmanifest`. Збірка Vite — у `/kp-assets/`.
- `site-bridge.js` додає в навігацію сайту «Клієнти» і «Звіт план/факт» (`#/clients…`, `#/report`), бере клієнт Supabase
  сайту (`supabaseClient`) — другого клієнта немає. Гейт: `kp_context().control_plus`, без тарифу — екран тарифу.
- `/api/*` — серверний rewrite Vercel на `https://trip-control.com/api/*`: для браузера той самий origin, CORS не потрібен,
  `Authorization: Bearer` проходить (перевірено локально через проксі `vite preview`: `/api/calculate` з поганим токеном → 401
  «Недійсний токен»). `api/*` не перевіряє Origin/Host.
- Service worker: сайт реєструє `/sw.js` — тут це SW застосунку (`public/sw.js`); sw.js сайту не копіюється.
  `/api`, Supabase, HTML і файли сайту `/assets/**` не кешуються SW.
- CSP сайту (з `'unsafe-inline'`) — лише на сторінках сайту (`/`, `/index.html`, `/legal/*`, `/offer`…), решта — строгий CSP.

### Відомі наслідки проксі

- **Інвайт-посилання** `api/team.js` будує з `SITE_URL` сервера сайту → ведуть на `trip-control.com/?team_invite=…`, не на app.
  Прийняти інвайт можна там (той самий акаунт), потім працювати в app.
- Повернення з оплати (WayForPay) — теж на `SITE_URL` (trip-control.com).
- Посилання «поділитися» (Viber/Telegram) і `emailRedirectTo` реєстрації беруть `location.origin` → `app.trip-control.com`.
- Ліміт `/api/poi` рахується за `x-forwarded-for`: перевірити на preview, що Vercel передає IP клієнта, а не свій.

## Ручні налаштування власника (не в коді)

1. **Vercel** (проєкт Контроль+): Root Directory = `apps/kontrol-plus`, увімкнено
   «Include files outside the root directory in the Build Step» — інакше `sync-site` падає з поясненням (сайт лежить у корені).
   Env-змінні Supabase більше не потрібні (`VITE_SUPABASE_*` можна прибрати).
2. **Supabase → Auth → URL Configuration**: додати `https://app.trip-control.com/*` у Redirect URLs (підтвердження email,
   скидання пароля з app).
3. **Google Cloud → Maps browser key → HTTP referrers**: додати `https://app.trip-control.com/*` (і preview-домен Vercel
   на час перевірки), інакше карта й маршрути в app не працюють.
4. Сесія per-origin (`localStorage` `sb-qkfqjorzsxcajcneohoy-auth-token`): на app треба увійти окремо.

## Доступ

Усі права — на сервері (RLS і функції БД з міграцій `20261022090000_kontrol_plus_access.sql`,
`20261022091000_kontrol_plus_clients_reports.sql`). Інтерфейс лише ховає кнопки.

| Хто | Клієнти | Привʼязка рейсів | Звіт |
|---|---|---|---|
| Власник org з планом `control_plus` | читає, додає, редагує, архівує, видаляє | будь-які рейси org | усі рейси |
| Логіст | читає, додає, редагує, архівує | лише свої рейси | свої (усі — якщо «логісти бачать усе») |
| Директор (`org_directors`, до 2 на org) | лише читання | — | усі рейси |
| Org без плану, чужа org, anon | нічого | — | `CONTROL_PLUS_REQUIRED` |

План змінює лише service role (`set_org_plan`) або SQL Editor; директорів додає лише service role.
Гарди Контроль+ дивляться на роль сесії (`anon` / `authenticated` — завжди клієнт), а не лише на claim `role`.

### Організація з клієнтами не видаляється (`clients.org_id … ON DELETE RESTRICT`)

Клієнтів не можна втратити каскадом. Наслідок:

- **Прийняття запрошення падає** (`23503`, foreign key violation), якщо стара організація користувача має клієнтів.
  `accept_org_invite` видаляє стару «порожню» організацію, а `org_has_user_data` (існуюча функція, не змінюється)
  клієнтів не рахує. Клієнти бувають лише в організаціях, що мали тариф `control_plus` (зараз або колись).
  Що робити: перенести або видалити клієнтів у старій org (service role / SQL), потім прийняти запрошення ще раз.
- **Пряме видалення такої організації** (`DELETE FROM organizations`, service role / SQL) так само падає з `23503`,
  доки в ній є клієнти.
- **На тарифі `company` усе як раніше**: реєстрація, прийняття запрошення з видаленням старої порожньої org,
  видалення org (рядки `org_directors` / `calculation_clients` видаляються каскадом). Перевіряє
  `supabase/tests/kontrol_plus.sql`.

## Стек

Vite + vanilla JS (без фреймворку) для CRM-вкладок; сайт — як є. Залежностей у runtime немає (Supabase JS вантажить сайт з CDN).

## Локально

```sh
cd apps/kontrol-plus
npm install
npm run dev                     # http://localhost:5174 — сайт + вкладки, /api проксі на trip-control.com
npm test                        # копія сайту без змін, інжект, rewrite, CSP, гейт, SW, валідація
npm run build && npm run preview  # http://localhost:4174 — те, що піде на Vercel
npm run check:scope             # поза apps/kontrol-plus/ немає змін відносно main
npm run check:db                # усі міграції + Контроль+ на PGlite і supabase/tests/kontrol_plus.sql
```

На localhost SW не реєструється (код сайту). Карта Google на localhost працює лише якщо ключ дозволяє цей referrer.

## Vercel

- Framework: Vite, Output: `dist`, `vercel.json` цієї теки (rewrites `/api` і юридичних сторінок, заголовки).
- Див. «Ручні налаштування власника» вище.

## PWA / Microsoft Store

`public/manifest.webmanifest` (id, standalone, window-controls-overlay, іконки any + maskable, скриншоти wide/narrow),
`public/sw.js`, `public/offline.html`. Service worker не перехоплює Supabase, інші домени й не-GET; HTML не кешує;
кешує лише `/kp-assets/*`, `/icons/*` і офлайн-сторінку. На localhost SW не реєструється.
Після деплою: PWABuilder → URL `https://app.trip-control.com` → пакет для Microsoft Store.
