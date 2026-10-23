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
- `src/site-bridge.js` (точка входу: стилі + `startBridge()` з `src/bridge.js`) додає в навігацію сайту «Клієнти» і
  «Звіт план/факт» (`#/clients…`, `#/report`), бере клієнт Supabase сайту (`supabaseClient`) — другого клієнта немає.
  Гейт: `kp_context().control_plus`, без тарифу — екран тарифу. Старий ключ сесії окремого застосунку `kp-auth`
  прибирається з `localStorage` при першому завантаженні (сесія сайту не чіпається).
- `/api/*` — серверний rewrite Vercel на `https://trip-control.com/api/*`: для браузера той самий origin, CORS не потрібен,
  `Authorization: Bearer` проходить (перевірено локально через проксі `vite preview`: `/api/calculate` з поганим токеном → 401
  «Недійсний токен»). `api/*` не перевіряє Origin/Host.
- Service worker: сайт реєструє `/sw.js` — тут це SW застосунку (`public/sw.js`); sw.js сайту не копіюється.
  `/api`, Supabase, HTML і файли сайту `/assets/**` не кешуються SW.
- CSP сайту (з `'unsafe-inline'`) — лише на сторінках сайту (`/`, `/index.html`, `/legal/*`, `/offer`…), решта — строгий CSP.

### Залежності моста від сайту

Міст не правує код сайту, але спирається на його розмітку й глобальні імена. Якщо щось із цього зникне, `startBridge()`
поверне `false` (вкладок немає, сайт працює як є, одне попередження в консолі), а тест
`the site still has every id / class / global the bridge depends on` (`tests/site.test.mjs`) впаде.

| Що | Де в сайті | Навіщо мосту |
|---|---|---|
| `const supabaseClient` (глобальна лексична змінна) | inline-скрипт ініціалізації Supabase | єдиний клієнт: сесія, `kp_context`, CRM-запити |
| `#tc-nav-panel .tc-studio-nav` | шапка застосунку | сюди додаються `#kp-nav-clients`, `#kp-nav-report` |
| `#main-app` | контейнер застосунку | сюди вставляється `#kp-crm` |
| `#studio-overview` | «Огляд» у `#main-app` | `#kp-crm` стає перед ним (немає — в кінець `#main-app`) |
| `#sticky-top`, `.tc-legal-footer` | діти `#main-app` | лишаються видимими у вкладках CRM, решта дітей ховається |
| `#studio-nav-calc`, `#studio-nav-overview`, клас `.on` | кнопки навігації | знімаємо підсвітку, поки відкрито CRM |
| `body[data-studio-view]` | `setStudioView()` | будь-яка зміна (калькулятор, огляд, логотип, «Історія», закриття кабінету) закриває CRM |
| `body[data-theme]` (`dark`) | `applyTheme()` | темна палітра `crm.css`; повторна синхронізація навігації |
| `#missing-hint`, `#onboard-banner`, `#cab-warning` | підказки над калькулятором | ховаються у вкладках CRM |
| `html[data-entry]`, `html[data-screen]` | перший inline-скрипт `<body>` | `kp-entry.js`: гість бачить вхід, не лендинг |
| `<link rel="manifest" href="/site.webmanifest">`, по одному `</head>` і `</body>` | `index.html` | точки інжекту (`site-html.mjs` падає, якщо їх не рівно по одному) |
| `navigator.serviceWorker.register('/sw.js')` | код сайту | реєструє SW застосунку; сам міст SW не реєструє |

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
