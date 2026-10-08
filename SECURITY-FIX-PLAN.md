# Фікс безпеки TRIP-CONTROL

Статус: **тиждень 2 у репо** (2026-10-08) — після week-1; частина кроків потребує ручних дій у Dashboard.

## Порядок дій

### Тиждень 1 — критично ✅
1. **RLS у Supabase** — ✅ `supabase/migrations/20261008_week1_rls_and_limits.sql`
2. **Google Maps API key** — ✅ docs + referrer на `trip-control.com` (ручне)
3. **Розрахунок на сервері** — ✅ `/api/calculate`, `/api/poi`
4. **`?preview=1` на prod** — ✅ лише local / staging

### Тиждень 2 — важливо
5. **Адмін / клієнтська база** — ✅ у репо: таблиця `org_company_profiles` (PII окремо від `company_settings`), RLS (своя org + platform admin читає всі), `security_audit_log` + тригер аудиту; кабінет пише/читає профіль з нової таблиці.  
   ⚠️ **Ручна дія:** виконати `supabase/migrations/20261008_week2_admin_auth_audit.sql`. Повний UI CRM адміна — окремо, дані вже доступні admin через RLS.
6. **Auth hardening** — ✅ клієнт: сильний пароль + rate limit логіну + підказка confirm email; docs: `docs/AUTH-HARDENING.md` (Confirm email / MFA / rate limits у Dashboard).
7. **Секрети** — ✅ `docs/SECRETS.md`; `service_role` лише в `/api/*`; anon у клієнті ок.
8. **Оплата** — ✅ скелет `api/billing-webhook.js` (секрет `BILLING_WEBHOOK_SECRET` → `is_approved` / org status); клієнт і далі не може self-approve.

### Далі — бажано
9. CSP, HTTPS-only headers; без секретів у логах.
10. Бекапи Supabase + моніторинг аномалій (спам Places / Directions).
11. Юридично: оферта / згода на обробку персональних даних (ЄДРПОУ, телефон тощо).
12. Не витрачати час на обфускацію UI замість RLS і серверних перевірок.
13. UI адмін-CRM поверх `org_company_profiles` + audit log.

## Ручний чеклист
- [x] Week-1 SQL у Supabase
- [x] Maps key referrer + API
- [x] Smoke preview / RLS
- [ ] **Week-2 SQL:** `supabase/migrations/20261008_week2_admin_auth_audit.sql`
- [ ] Supabase: Confirm email (prod) — див. `docs/AUTH-HARDENING.md`
- [ ] Vercel env: `BILLING_WEBHOOK_SECRET` (коли підключите платіжку)
