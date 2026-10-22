# Контроль+

CRM перевізника поруч із trip-control.com: клієнти з реквізитами ТОВ / ФОП, історія рейсів і ставок по клієнту,
звіт план/факт. Та сама база й ті самі акаунти Supabase, що й на сайті. Окремий Vercel-проєкт
(Root Directory = `apps/kontrol-plus`, домен у майбутньому `app.trip-control.com`).

Сайт (`index.html`, `api/**`, …) цей застосунок не змінює і від нього не залежить.

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

Vite + vanilla JS (без фреймворку): кілька екранів, жодного runtime фреймворку в бандлі, той самий стиль коду,
що на сайті; Vite дає env-змінні збірки, хешовані файли й dev-сервер. Supabase JS — єдина залежність.

## Локально

```sh
cd apps/kontrol-plus
cp .env.example .env.local      # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (публічні, як на сайті)
npm install
npm run dev                     # http://localhost:5174
npm test                        # валідація, CSV, SW, manifest, CSP, відсутність секретів
npm run check:db                # усі міграції + Контроль+ на PGlite і supabase/tests/kontrol_plus.sql
```

Для перевірки на справжній БД — локальний Supabase (`supabase start`, потім `supabase test db`) або preview-гілка
Supabase. На прод міграції не застосовуються без окремого дозволу.

## Vercel

- Root Directory: `apps/kontrol-plus`, Framework: Vite, Output: `dist`.
- Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (опційно `VITE_SITE_URL`).
- Supabase Auth → URL Configuration: додати `https://app.trip-control.com` до Redirect URLs (вхід паролем працює й без
  цього; потрібно для майбутніх листів / magic link).
- Сесія не спільна між доменами: на `app.trip-control.com` треба увійти тим самим email і паролем.

## PWA / Microsoft Store

`public/manifest.webmanifest` (id, standalone, window-controls-overlay, іконки any + maskable, скриншоти wide/narrow),
`public/sw.js`, `public/offline.html`. Service worker не перехоплює Supabase, інші домени й не-GET; HTML не кешує;
кешує лише `/assets/*`, `/icons/*` і офлайн-сторінку. На localhost SW не реєструється.
Після деплою: PWABuilder → URL `https://app.trip-control.com` → пакет для Microsoft Store.
