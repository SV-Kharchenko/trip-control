# Секрети TRIP-CONTROL

| Секрет | Де | Ок у клієнті? |
|--------|-----|----------------|
| Supabase **anon** / publishable key | `index.html` | Так (з RLS) |
| Supabase **service_role** | Vercel env `SUPABASE_SERVICE_ROLE_KEY` лише в `/api/*` | **Ні** |
| `INVITE_SIGNING_SECRET` | Vercel env, лише підпис посилань `/api/team` | **Ні** |
| Google Maps browser key | `index.html` + referrer/API restrictions | Так (обмежений) |
| `BILLING_WEBHOOK_SECRET` | Vercel env + header webhook | **Ні** |
| `RESEND_API_KEY` | Vercel env, лише `/api/weekly-report` | **Ні** |
| `REPORT_FROM_EMAIL` | Vercel env, відправник листів звіту (`Name <mail@domain>`) | **Ні** |
| `CRON_SECRET` | Vercel env. Cron надсилає його як `Authorization: Bearer`. Без нього розсилка не стартує | **Ні** |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Vercel env, лише `/api/signup-notify` (сповіщення про нову реєстрацію) | **Ні** |

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
