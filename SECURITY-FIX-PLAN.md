# Фікс безпеки TRIP-CONTROL

Статус: **тижні 1–2 + «далі» у репо** (2026-10-09).

## Порядок дій

### Тиждень 1 — критично ✅
1. RLS, Maps key, серверний calc, `?preview=1` на prod.

### Тиждень 2 — важливо ✅
5. `org_company_profiles` + audit + RLS admin  
6. Auth hardening (клієнт + Dashboard)  
7. Секрети docs  
8. `api/billing-webhook.js`

### Далі — бажано
9. **CSP / headers** — ✅ `vercel.json` (HSTS, CSP, X-Frame-Options…)  
10. **Бекапи / моніторинг** — ✅ `docs/BACKUPS.md`  
11. **Юридично** — ✅ `legal/offer.html`, `legal/privacy.html` + згода на реєстрації  
12. Не обфускація замість RLS — ✅ принцип дотримано  
13. **UI адмін-CRM** — ✅ кнопка CRM (лише `role=admin`), `/api/admin`, клієнти + схвалення/блок + аудит  

## Ручний чеклист
- [x] Week-1 SQL
- [x] Week-2 SQL
- [x] Maps referrer
- [x] Confirm email / Site URL / MFA TOTP
- [ ] Vercel env `BILLING_WEBHOOK_SECRET` (коли підключите платіжку)
- [ ] Уточнити реквізити в `legal/offer.html` (ФОП/ТОВ, IBAN, email підтримки)
- [ ] Переконатись, що ваш акаунт має `profiles.role = 'admin'` (інакше кнопка CRM не з’явиться)
