# Billing webhook

Ендпоінт: `POST /api/billing-webhook`

Єдиний серверний шлях для зміни `profiles.is_approved` і статусу org після оплати. Клієнт не може self-approve (SQL-тригер week-1). Адмін може схвалити вручну через CRM (`/api/admin`).

## Налаштування Vercel

1. Project → **Settings → Environment Variables**
2. Додайте:
   - `BILLING_WEBHOOK_SECRET` — довгий випадковий рядок
   - уже мають бути: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. Redeploy після додавання env.

## Платіжка

Поки провайдер не підключений — webhook готовий приймати події. Коли оберете LiqPay / WayForPay / Stripe:

1. У кабінеті провайдера вкажіть URL: `https://trip-control.com/api/billing-webhook`
2. Той самий секрет у header `X-Billing-Secret` (або Bearer)
3. Мапте їхні події на наші `event` (див. нижче) або додайте адаптер у `api/billing-webhook.js`

## Приклад тіла

```json
{
  "event": "subscription.active",
  "org_id": "uuid-організації",
  "user_id": null,
  "plan": "pro"
}
```

| event | ефект |
|-------|--------|
| `subscription.active` | `is_approved=true`, org `active` |
| `subscription.canceled` | `is_approved=false`, org `blocked` |
| `subscription.past_due` | `is_approved=false` |

## Тест (curl)

```bash
curl -X POST https://trip-control.com/api/billing-webhook \
  -H "Content-Type: application/json" \
  -H "X-Billing-Secret: YOUR_SECRET" \
  -d "{\"event\":\"subscription.active\",\"org_id\":\"ORG_UUID\"}"
```
