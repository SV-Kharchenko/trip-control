# Секрети TRIP-CONTROL

| Секрет | Де | Ок у клієнті? |
|--------|-----|----------------|
| Supabase **anon** / publishable key | `index.html` | Так (з RLS) |
| Supabase **service_role** | Vercel env `SUPABASE_SERVICE_ROLE_KEY` лише в `/api/*` | **Ні** |
| `INVITE_SIGNING_SECRET` | Vercel env, лише підпис посилань `/api/team` | **Ні** |
| Google Maps browser key | `index.html` + referrer/API restrictions | Так (обмежений) |
| `BILLING_WEBHOOK_SECRET` | Vercel env + header webhook | **Ні** |
| `RESEND_API_KEY` | Vercel env, лише сервер: `/api/weekly-report` і листи-запрошення `/api/team` | **Ні** |
| `REPORT_FROM_EMAIL` | Vercel env, відправник листів звіту (`Name <mail@domain>`) | **Ні** |
| `INVITE_FROM_EMAIL` | Vercel env, відправник листів-запрошень (`Name <mail@domain>`). Порожньо — береться `REPORT_FROM_EMAIL`; без обох лист не йде, власник копіює посилання в «Команді» | **Ні** |
| `CRON_SECRET` | Vercel env. Cron надсилає його як `Authorization: Bearer`. Без нього розсилка не стартує | **Ні** |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Vercel env, `/api/signup-notify` і `/api/telegram-webhook`. `TELEGRAM_CHAT_ID` — єдиний чат, з якого бот приймає команди | **Ні** |
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
