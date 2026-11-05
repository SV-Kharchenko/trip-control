# Staging і глобальний вимикач модулів

Мета: Vercel **Preview**-деплої працюють з окремою staging-базою Supabase, а **Production** — з продовою, без змін у поведінці.

## Як це працює

Адреса бази й публічний (anon / publishable) ключ більше не зашиті в `index.html`. Сторінка підключає блокувальний `<script src="/api/config">`,
який віддає `window.TC_CONFIG` з env Vercel (`api/config.js`, логіка в `lib/public-config.js`; для «Контроль+» — така сама функція в
`apps/kontrol-plus/api/config.js`).

| Env | Де обовʼязкова | Що |
|---|---|---|
| `SUPABASE_URL` | Production **і** Preview | `https://<ref>.supabase.co` проєкту цього середовища |
| `SUPABASE_ANON_KEY` | Production **і** Preview | **публічний** anon / publishable ключ (не service role!) |
| `KP_DISABLED_FEATURES` | необовʼязково | модулі, вимкнені без міграції, через кому (див. нижче) |
| `APP_ENV` | необовʼязково | перекриває `VERCEL_ENV` для бейджа (`production` ховає його) |

- **Запасних продових значень немає.** Якщо `SUPABASE_URL` / `SUPABASE_ANON_KEY` не задано чи ключ схожий на service role, `/api/config` повертає
  503 і сторінка показує явну помилку «Не вдалося завантажити конфігурацію застосунку» — а не мовчки йде в продову базу.
- Service role у відповідь не потрапляє ніколи: віддаються лише `supabaseUrl`, `supabaseAnonKey`, `env`, `disabledFeatures`.
- Ключ сесії Supabase у `localStorage` = `sb-<ref>-auth-token`. На проді `SUPABASE_URL` той самий, що був у коді, тож ref і ключ не змінюються:
  продових користувачів це **не розлогінить**.
- Поза продом (`VERCEL_ENV` ≠ `production`) зверху сторінки з'являється бейдж **STAGING** (CSS-змінні `--tc-staging-bg` / `--tc-staging-ink`).
  На проді його немає.

### ⚠ Перед першим деплоєм цієї зміни на прод

У Vercel Production env уже є `SUPABASE_URL` (його використовують `api/*`), але **`SUPABASE_ANON_KEY` може бути не заданий**. Задайте його (значення —
публічний ключ із Supabase → Settings → API; це той самий ключ, що раніше стояв у `index.html`) і перевірте, що `SUPABASE_URL` дорівнює
`https://qkfqjorzsxcajcneohoy.supabase.co`. Без цього після деплою сайт покаже явну помилку конфігурації. Те саме — для проєкту Vercel «Контроль+».
Після деплою відкрийте `/api/config` — це має бути JS із `window.TC_CONFIG` (без бейджа STAGING).

## Як створити staging

1. Supabase → New project (Free). Запишіть `ref`, URL, anon key, service role key (service role **тільки** у Vercel Preview env, не в код і не в чат).
2. Накотіть усі міграції з `supabase/migrations/` у порядку імен: `supabase link --project-ref <staging-ref>` і `supabase db push`
   (або по черзі в SQL-редакторі). Міграції мають шапку «Apply manually» — це нормально для staging; на прод вони йдуть окремо, вручну.
3. Auth → URL Configuration: Site URL і Redirect URLs — адреси Preview-деплою (інакше підтвердження пошти й recovery поведуть не туди).
4. Vercel → Project → Settings → Environment Variables → для **Preview** (і лише Preview) задайте:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — і решту змінних, що читає `api/` (див. `docs/SECRETS.md`: `RESEND_API_KEY`,
   `TELEGRAM_*`, `GOOGLE_MAPS_*`, платіжні ключі тощо) — **тестовими** значеннями або взагалі без них (тоді відповідні функції відповідають «не налаштовано»).
   **Production env не змінюйте** (окрім `SUPABASE_ANON_KEY`, див. вище). Те саме зробіть у проєкті Vercel «Контроль+».
5. Засів тестових даних (лише staging):

   ```sh
   SUPABASE_URL=https://<staging-ref>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=<staging service role> \
   STAGING_SEED_PASSWORD=<≥12 символів, спільний для тестових акаунтів> \
   STAGING_SEED_CONFIRM=yes \
   node scripts/staging-seed/index.mjs
   ```

   Скрипт ідемпотентний і **відмовляється працювати** проти продового ref чи при `VERCEL_ENV=production`. Він створює демо-організацію
   «Demo Agro (staging)» на `control_plus` і акаунти `owner@`, `director@`, `logist@`, `repair@`, `requester@` на домені `staging.example.com`
   (Директор, Менеджер, Логіст, Відповідальний за ремонти, Замовник підрозділу); вмикає «Власний парк» (прапорець організації + `app_settings`),
   додає 2 підрозділи, 3 точки й прикріплює замовника до першого підрозділу. Якщо міграцій «Власного парку» ще немає, ці кроки пропускаються з нотаткою —
   накотіть міграції й запустіть скрипт ще раз.
6. Зробіть push у гілку → Preview-деплой → відкрийте його: зверху має бути «STAGING», вхід — тестовими акаунтами.

## Глобальний вимикач модулів

Таблиця `app_settings(key, enabled, updated_at)` (міграція `20261122090000_app_settings_kill_switch.sql`): читати можуть authenticated, писати — лише
service_role / SQL-редактор. `feature_enabled(key)` повертає `enabled`; **немає рядка → вимкнено**. `org_has_feature(org, key) = feature_enabled(key) AND
прапорець організації` (`organizations.features ->> key = 'true'`). Модуль працює, лише коли ввімкнено **і** глобально, **і** для організації.

### ⚠ Після цієї міграції «Власний парк» вимкнений для всіх

Міграція **не вставляє** рядок `own_fleet` в `app_settings`, а «немає рядка» означає «вимкнено». Тому одразу після її застосування модуль «Власний парк»
зникає у **всіх** організацій — навіть у тих, у кого вже стоїть прапорець `features.own_fleet` (пункт меню, роути, вікна, блок «Замовники підрозділів»,
RLS-таблиці модуля віддають 0 рядків). Дані не втрачаються. Щоб повернути модуль, вставте рядок явно:

```sql
-- Увімкнути «Власний парк» глобально (після цього він працює в організаціях із прапорцем features.own_fleet = true):
INSERT INTO public.app_settings (key, enabled) VALUES ('own_fleet', true)
ON CONFLICT (key) DO UPDATE SET enabled = true;

-- Вимкнути для всіх одним UPDATE (дані лишаються, усі таблиці модуля одразу віддають 0 рядків, навіть директору):
UPDATE public.app_settings SET enabled = false WHERE key = 'own_fleet';

-- Прапорець однієї організації (потрібен на додачу до глобального):
UPDATE public.organizations SET features = features || '{"own_fleet": true}'::jsonb WHERE id = '<org uuid>';
```

Staging-засів (`scripts/staging-seed`) сам вставляє `own_fleet = true`. Якщо на проді «Власний парк» уже використовується, **виконайте INSERT вище в тому самому
вікні, що й міграцію**, інакше модуль на якийсь час зникне.

### Аварійний вимикач: env KP_DISABLED_FEATURES

`KP_DISABLED_FEATURES=own_fleet` (через кому для кількох модулів) у env Vercel — запасний вимикач, коли SQL недоступний. Він **діє після редеплою** (env читаються
при старті функцій; `/api/config` додатково кешується браузером до хвилини) і гасить модуль, навіть якщо прапорець організації й `app_settings` увімкнені:
- **фронт «Контроль+»:** `window.TC_CONFIG.disabledFeatures` → `featureDisabled('own_fleet')`: контекст модуля не запитується, тож немає пункту меню, роути
  (`#/own-fleet…`) ведуть на огляд, не відкриваються вікна карток і не показується блок «Замовники підрозділів» у «Команді»;
- **API `/api/own-fleet/invites`:** будь-яка дія (включно з `accept`) повертає 503 `FEATURE_DISABLED` з текстом «Модуль «Власний парк» тимчасово вимкнено
  адміністратором платформи», до БД запит не доходить.

Це лише інтерфейс і API: на рівні БД (RLS) модуль гасить тільки `app_settings` — він надійніший. Тому для повного вимкнення використовуйте SQL вище, а env —
як швидкий запасний варіант. Повернути модуль: прибрати `own_fleet` зі змінної й зробити редеплой.
