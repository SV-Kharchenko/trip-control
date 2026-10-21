# Supabase (TRIP-CONTROL)

## Week-1 security migration ✅

Файл: `migrations/20261008_week1_rls_and_limits.sql`

RLS на `profiles`, `organizations`, `company_settings`, `calculations`, `usage_counters`; блок `role` / `is_approved` / `org.status`; демо-save ≤ 3; `bump_calc_usage`.

## Week-2 security migration

Файл: `migrations/20261008_week2_admin_auth_audit.sql`

- Таблиця `org_company_profiles` (PII компанії) + backfill з `company_settings`
- `security_audit_log` + тригер на зміни профілю
- `is_platform_admin()` — admin бачить усі org/profiles/settings (CRM)
- Операційні норми лишаються в `company_settings` без `co*` ключів

### Як застосувати (ручна дія)

1. [Supabase Dashboard](https://supabase.com/dashboard) → **SQL Editor**.
2. Вставте **вміст** файлу міграції (не шлях) і **Run**.
3. Спочатку week-1 (якщо ще ні), потім week-2.
4. Smoke week-2:
   - зберегти вкладку «Компанія» → рядок у `org_company_profiles`, запис у `security_audit_log`;
   - звичайний юзер не читає чужі org;
   - `role = admin` може `select` усі `org_company_profiles`.

Auth / MFA / Confirm email: `docs/AUTH-HARDENING.md`.  
Секрети: `docs/SECRETS.md`.  
Оплата: `api/billing/[route].js`, міграція `20261018190000_payments.sql` — `docs/PAYMENTS.md`.

`service_role` (Vercel `SUPABASE_SERVICE_ROLE_KEY`) — лише `/api/*`, ніколи фронт.

## Права на функції (`20261021090000_security_grants.sql`)

- Тригерні функції (`audit_org_company_profiles`, `calculations_enforce_owner_and_demo_limit`, `enforce_demo_save_limit`) —
  без EXECUTE для `anon` / `authenticated` (тригери працюють: право перевіряється при створенні тригера).
- Хелпери з RLS-політик (`current_org_id`, `is_org_owner`, `is_platform_admin`, `is_user_blocked`, `org_logists_see_all`) —
  лише `authenticated` і `service_role`; не потрібні клієнту (`current_org_role`, `current_is_approved`, `is_admin`,
  `my_org_id`) — лише `service_role`. Перед змінами міграція перевіряє, що закриті хелпери не використовує жодна політика,
  view чи SECURITY INVOKER-функція, і інакше зупиняється, нічого не змінивши.
- `touch_route_template`, `is_service_role`, `tc_num`, `ua_today` — `search_path = ''`.
- Перевірка: `node scripts/check-security-grants.mjs` — усі міграції по черзі на заглушці базової схеми прод (PGlite),
  потім ця міграція і сценарії: демо й ліміти, власник + логіст, шаблони, профіль компанії, оплата, блокування.
  Таблиці й функції, яких немає в репо, але є на прод, заглушка лише імітує: міграцію на прод — лише після перевірки.
