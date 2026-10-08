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
Webhook оплати: `api/billing-webhook.js` + env `BILLING_WEBHOOK_SECRET`.

`service_role` (Vercel `SUPABASE_SERVICE_ROLE_KEY`) — лише `/api/*`, ніколи фронт.
