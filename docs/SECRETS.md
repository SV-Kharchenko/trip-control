# Секрети TRIP-CONTROL

| Секрет | Де | Ок у клієнті? |
|--------|-----|----------------|
| Supabase **anon** / publishable key | `index.html` | Так (з RLS) |
| Supabase **service_role** | Vercel env `SUPABASE_SERVICE_ROLE_KEY` лише в `/api/*` | **Ні** |
| Google Maps browser key | `index.html` + referrer/API restrictions | Так (обмежений) |
| `BILLING_WEBHOOK_SECRET` | Vercel env + header webhook | **Ні** |

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
