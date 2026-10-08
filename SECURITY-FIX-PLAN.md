# Фікс безпеки TRIP-CONTROL

Статус: **тиждень 1 у репо** (2026-10-08) — код/SQL/docs залиті; частина кроків потребує ручних дій у Dashboard.

## Порядок дій

### Тиждень 1 — критично
1. **RLS у Supabase** — ✅ у репо: `supabase/migrations/20261008_week1_rls_and_limits.sql` + `supabase/README.md`.  
   Політики на `profiles`, `organizations`, `company_settings`, `calculations`, `usage_counters`; тригери блокують клієнтську зміну `role` / `is_approved` / `org.status`; демо-save ≤ 3 на рівні БД.  
   ⚠️ **Ручна дія:** виконати SQL у Supabase SQL Editor (див. README).
2. **Google Maps API key** — ✅ docs: `docs/GOOGLE-MAPS-API-KEY.md`; у коді константа `GOOGLE_MAPS_BROWSER_KEY` + посилання на docs (Maps не зламано).  
   ⚠️ **Ручна дія:** HTTP referrer + API restrictions, окремий prod-ключ, billing alerts у Google Cloud Console.
3. **Розрахунок на сервері** — ✅ уже в `/api/calculate` (auth, org blocked, `is_approved` з БД, `bump_calc_usage`); посилено коментар / перевірку blocked у `/api/poi`; DEMO_SAVE_LIMIT у SQL-тригері.
4. **`?preview=1` на prod** — ✅ увімкнено лише на localhost / `file:` / hostname зі `staging`; на prod ігнорується, йде звичайний auth.

### Тиждень 2 — важливо
5. **Адмін / клієнтська база** — дані вкладки «Компанія» в окремій структурі + RLS: читає тільки admin; аудит змін.
6. **Auth hardening** — підтвердження email, rate limit login/signup, сильні паролі; MFA для admin.
7. **Секрети** — anon key у клієнті ок; `service_role` ніколи у фронті; ротація ключів, якщо світились у git/чатах.
8. **Оплата** — статус підписки лише з webhook (платіжка → сервер → `is_approved` / plan).

### Далі — бажано
9. CSP, HTTPS-only headers; без секретів у логах.
10. Бекапи Supabase + моніторинг аномалій (спам Places / Directions).
11. Юридично: оферта / згода на обробку персональних даних (ЄДРПОУ, телефон тощо).
12. Не витрачати час на обфускацію UI замість RLS і серверних перевірок.

## Ручний чеклист після деплою коду
- [ ] Застосувати `supabase/migrations/20261008_week1_rls_and_limits.sql` у Supabase
- [ ] Обмежити Google Maps API key (referrer + API + budget alert)
- [ ] Smoke: демо не бачить чужі org; `?preview=1` на prod не відкриває UI без логіну
