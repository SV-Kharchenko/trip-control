# Supabase (TRIP-CONTROL)

## Week-1 security migration

Файл: `migrations/20261008_week1_rls_and_limits.sql`

Увімкнює RLS на `profiles`, `organizations`, `company_settings`, `calculations`, `usage_counters`; блокує клієнтську зміну `role` / `is_approved` / `org.status`; обмежує демо-збереження (3) на рівні БД; тримає `bump_calc_usage` для серверного денного ліміту розрахунків.

### Як застосувати (ручна дія)

1. Відкрийте [Supabase Dashboard](https://supabase.com/dashboard) → проєкт TRIP-CONTROL → **SQL Editor**.
2. Вставте вміст `migrations/20261008_week1_rls_and_limits.sql` і виконайте.
3. Перевірте **Authentication → Policies** (або Table Editor → RLS): політики з’явились, RLS увімкнено.
4. Smoke-тест:
   - логін демо-юзера → SELECT лише своєї org;
   - спроба `update profiles set is_approved = true` з anon-ключа клієнта → помилка;
   - 4-те збереження розрахунку в демо → `DEMO_SAVE_LIMIT`;
   - `/api/calculate` для демо далі рахує ліміт через RPC.

`service_role` (Vercel env `SUPABASE_SERVICE_ROLE_KEY`) обходить RLS — ним користуються лише Edge/API функції, ніколи фронт.
