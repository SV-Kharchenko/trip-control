# Billing webhook

Ендпоінт: `POST /api/billing-webhook`

Єдиний серверний шлях для зміни `profiles.is_approved` і статусу org після оплати. Клієнт не може self-approve (SQL-тригер week-1).

## Налаштування

1. У Vercel додайте env `BILLING_WEBHOOK_SECRET` (довгий випадковий рядок).
2. У платіжці (LiqPay / Stripe / тощо) вкажіть webhook URL і той самий секрет у header `X-Billing-Secret`.

## Приклад тіла

```json
{
  "event": "subscription.active",
  "org_id": "uuid-організації",
  "user_id": null,
  "plan": "pro"
}
```

Події: `subscription.active` → approved; `subscription.canceled` / `subscription.past_due` → не approved (canceled також `org.status = blocked`).
