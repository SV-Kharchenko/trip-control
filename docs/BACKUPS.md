# Бекапи та моніторинг

## Supabase

1. Dashboard → **Project Settings → Database → Backups** (на Pro — PITR; на Free — ручний dump).
2. Періодично: Table Editor → Export або `pg_dump` через connection string.
3. Зберігайте копію міграцій з `supabase/migrations/` у git (уже є).

## Аномалії Maps / Directions

- Google Cloud → Billing alerts + Quotas на Maps/Places/Directions.
- Referrer уже обмежено доменом `trip-control.com`.
- У логах Vercel `/api/*` — без секретів і токенів у plain text.

## Що перевіряти щомісяця

- [ ] Billing alert Google спрацьовує на тестовий поріг
- [ ] RLS увімкнено на ключових таблицях
- [ ] Немає `service_role` у фронті / публічних логах
