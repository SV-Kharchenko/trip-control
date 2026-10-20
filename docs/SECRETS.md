# Секрети TRIP-CONTROL

| Секрет | Де | Ок у клієнті? |
|--------|-----|----------------|
| Supabase **anon** / publishable key | `index.html` | Так (з RLS) |
| Supabase **service_role** | Vercel env `SUPABASE_SERVICE_ROLE_KEY` лише в `/api/*` | **Ні** |
| `INVITE_SIGNING_SECRET` | Vercel env, лише підпис посилань `/api/team` | **Ні** |
| Google Maps browser key | `index.html` + referrer/API restrictions | Так (обмежений) |
| `PUBLIC_BASE_URL` | Vercel env (`https://trip-control.com`), адреси повернення й вебхуків оплати | — |
| `PAYMENTS_ENABLED` | Vercel env: `1` — створення рахунків увімкнено; інше — 503, вебхуки й статус працюють | — |
| `MONO_TOKEN` | Vercel env, лише `/api/billing/*` (plata by mono, header `X-Token`) | **Ні** |
| `MONO_PUBKEY` | Vercel env, опційно: base64 PEM ключа вебхуків mono (інакше береться з `/api/merchant/pubkey`) | Публічний ключ, але лише сервер |
| `WAYFORPAY_MERCHANT_ACCOUNT` | Vercel env, лише `/api/billing/*` | **Ні** |
| `WAYFORPAY_SECRET_KEY` | Vercel env, лише `/api/billing/*` (HMAC_MD5 підписи) | **Ні** |
| `WAYFORPAY_MERCHANT_DOMAIN` | Vercel env (`trip-control.com`) | — |
| `WAYFORPAY_MERCHANT_PASSWORD` | Vercel env, лише `/api/billing/*`: regularApi WayForPay (STATUS / REMOVE автопродовження). Не логується, не повертається | **Ні** |
| `AUTO_RENEW_ENABLED` | Vercel env: `1` — галочка автопродовження (WayForPay) на екрані оплати; інше — галочки немає, вже ввімкнене автопродовження однаково обробляється й скасовується | — |
| `RESEND_API_KEY` | Vercel env, лише сервер: `/api/weekly-report`, листи-запрошення `/api/team`, нагадування про оплату `/api/billing/cron` | **Ні** |
| `REPORT_FROM_EMAIL` | Vercel env, відправник листів звіту (`Name <mail@domain>`) | **Ні** |
| `INVITE_FROM_EMAIL` | Vercel env, відправник листів-запрошень (`Name <mail@domain>`). Порожньо — береться `REPORT_FROM_EMAIL`; без обох лист не йде, власник копіює посилання в «Команді» | **Ні** |
| `CRON_SECRET` | Vercel env. Cron надсилає його як `Authorization: Bearer` (`/api/weekly-report`, `/api/billing/cron`). Без нього крон не стартує | **Ні** |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Vercel env, `/api/signup-notify`, `/api/telegram-webhook` і алерти про оплату / повернення з `/api/billing/*`. `TELEGRAM_CHAT_ID` — єдиний чат, з якого бот приймає команди | **Ні** |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel env. Telegram надсилає його в `X-Telegram-Bot-Api-Secret-Token`; без збігу `/api/telegram-webhook` відповідає 401. Той самий передається в `scripts/set-telegram-webhook.js` | **Ні** |

## Правила

1. `service_role` ніколи не потрапляє в `index.html`, git-історію чатів, скріни.
2. Якщо секрет світився публічно — **ротація** в Supabase / Google / Vercel.
3. Anon key без RLS = небезпека; після week-1 RLS обов’язковий.

## Перевірка

```bash
# у репо не повинно бути service_role у фронті
rg "SERVICE_ROLE|service_role" index.html
# (очікується порожньо)
```
