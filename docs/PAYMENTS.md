# Оплата тарифу (plata by mono, WayForPay)

Тариф — на організацію; платить лише власник (`org_role = 'owner'`). Автосписань немає: кожна оплата — окремий рахунок.

| Тариф | Ціна | mono (`amount`, `ccy`) | WayForPay (`amount`, `currency`) |
|-------|------|------------------------|----------------------------------|
| `month` | 250 грн | `25000`, `980` | `250`, `UAH` |
| `year` | 2500 грн | `250000`, `980` | `2500`, `UAH` |

Сума — **лише** з коду плану на сервері (`lib/billing/plans.js`); ціну від клієнта не приймаємо.
Apple Pay / Google Pay — на hosted-сторінках обох провайдерів, свого віджета немає.

## Потік

```
Клієнт (меню → «Тариф і оплата»)
  │  POST /api/billing/create-invoice { plan, provider, consent: true, legal_version }
  ▼
api/billing/[route].js  ── JWT, власник, активна компанія, згода, ≤ 10 рахунків/год
  │  payments(status='created') → legal_consents(kind='payment', payment_id)
  │  mono: POST api.monobank.ua/api/merchant/invoice/create (basketOrder для ПРРО)
  │  WayForPay: POST secure.wayforpay.com/pay?behavior=offline → {url}
  │            (якщо ні — CREATE_INVOICE на api.wayforpay.com/api → invoiceUrl)
  │  payments(status='pending', provider_invoice_id)
  ▼
{ payment_id, url } → location.href = url → hosted-сторінка провайдера
  │
  ├─► вебхук провайдера → /api/billing/mono-webhook | /api/billing/wayforpay-webhook
  │     підпис → payment_events → статус (лише новіший за provider_modified_at)
  │     success → apply_payment_success() → org_subscriptions.paid_until (+1 міс / +1 рік)
  │                 + Telegram «💳 Оплата: …» (лише при фактичному зарахуванні)
  │     reversed  → статус + подія + Telegram «↩️ Повернення: …» (paid_until не скорочуємо)
  │
  └─► повернення клієнта → /api/billing/return?pid= → 303 /?billing=return&pid=
        клієнт поллить GET /api/billing/status?pid= кожні 3 с до 60 с
        (status питає провайдера, якщо вебхук ще не дійшов)
```

Доступ: `current_is_approved()` = ручне `profiles.is_approved` **або** `paid_until > now()`.
Ручне схвалення (Telegram full/demo, CRM) — постійний повний доступ незалежно від оплати.
Після `paid_until` компанія сама повертається в демо (5 розрахунків/добу, 3 збережені, 1 шаблон); дані не видаляються.

Щоденний крон `/api/billing/cron` (07:00 UTC ≈ 10:00 Київ, `Bearer CRON_SECRET`):
- лист «Trip Control: доступ діє до DD.MM.YYYY» власникам, у яких `paid_until` за Києвом = сьогодні + 3 дні
  (один раз на кожне `paid_until`, `reminder_sent_for`); без `RESEND_API_KEY` / `REPORT_FROM_EMAIL` — не шле і не позначає;
- звірка: платежі `created` / `pending` віком від 10 хв до 48 год → той самий status-check;
- нічого не видаляє.

## Маршрути (одна функція `api/billing/[route].js`)

| Метод | Шлях | Що робить |
|-------|------|-----------|
| POST | `/api/billing/create-invoice` | рахунок; 503 якщо `PAYMENTS_ENABLED != 1` або провайдер без env |
| GET, POST | `/api/billing/return?pid=` | 303 на `/?billing=return&pid=`; нічого не зараховує |
| POST | `/api/billing/mono-webhook` | `x-sign` (ECDSA SHA-256, сире тіло); 401 без запису при невалідному |
| POST | `/api/billing/wayforpay-webhook` | HMAC_MD5; на валідний (і повтор) — `{orderReference, status:'accept', time, signature}`; 401 при невалідному |
| GET | `/api/billing/status?pid=` | власник своєї компанії; питає провайдера для `created`/`pending` |
| GET | `/api/billing/summary` | `paid_until`, ціни, доступні провайдери, останні 20 платежів (власнику) |
| GET | `/api/billing/cron` | нагадування й звірка |

URL вебхуків у кабінетах провайдерів:
- mono: передається в кожному рахунку (`webHookUrl` = `PUBLIC_BASE_URL/api/billing/mono-webhook`);
- WayForPay: `serviceUrl` = `PUBLIC_BASE_URL/api/billing/wayforpay-webhook` (передається в кожному запиті).

## Дані

Міграція `supabase/migrations/20261018190000_payments.sql` (на прод — лише після перевірки):
- `org_subscriptions` — `paid_until` на компанію (окрема таблиця: власник має UPDATE на `organizations`);
- `payments` — рахунки (`provider_order_id`: mono = id платежу, WayForPay = `tc-<id>`);
- `payment_events` — історія статусів, лише поля зі списку (статус, сума, валюта, дата, причина, метод, маска картки);
- RLS: платежі бачить власник; підписку — усі учасники компанії; події — ніхто з клієнтів; пише лише `service_role`;
- `apply_payment_success()` — ідемпотентне зарахування; `apply_payment_status()` — інші статуси, лише новіші.

Перевірка: `node scripts/check-payments-rls.mjs` (PGlite), `npm test`.

## Env (лише Vercel → Settings → Environment Variables)

| Змінна | Значення |
|--------|----------|
| `MONO_TOKEN` | токен еквайрингу mono (header `X-Token`) |
| `MONO_PUBKEY` | опційно: base64 PEM ключа вебхуків; при невдалій перевірці ключ однаково перезапитується |
| `WAYFORPAY_MERCHANT_ACCOUNT` | логін мерчанта |
| `WAYFORPAY_SECRET_KEY` | SecretKey мерчанта |
| `WAYFORPAY_MERCHANT_DOMAIN` | `trip-control.com` |
| `PUBLIC_BASE_URL` | `https://trip-control.com` |
| `PAYMENTS_ENABLED` | `1`, коли готові приймати оплату |
| вже є | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `REPORT_FROM_EMAIL`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Без `SUPABASE_*` / `PUBLIC_BASE_URL` / env провайдера цей провайдер недоступний (summary його не показує, create-invoice → 503).
Секрети не логуються й не повертаються в помилках. У коді, чаті й на скрінах їх не буває.

## Тестування в sandbox

- **mono**: тестовий токен — на https://api.monobank.ua/ (розділ еквайрингу, тестовий режим). Класти **лише в Preview env**.
- **WayForPay**: тестовий мерчант і ключ — з документації WayForPay (тестові картки там же). Лише в Preview env.
- На Preview вебхуки провайдерів **не дійдуть** через Vercel Deployment Protection. Перевіряйте через
  `GET /api/billing/status?pid=` (його й так викликає екран після повернення) або увімкніть Protection Bypass for Automation
  і додайте bypass-параметр до URL вебхука.
- Сценарій: власник → меню → «Тариф і оплата» → тариф, спосіб, згода → «Оплатити» → тестова картка → повернення
  на `/?billing=return&pid=…` → «Оплату зараховано. Доступ діє до …».

## Повернення коштів (вручну)

1. Оформити повернення в кабінеті провайдера (mono / WayForPay).
2. У нас — SQL від `service_role`:

```sql
UPDATE public.payments
SET status = 'refunded', refund_note = 'Повернення за запитом від DD.MM.YYYY, сума …', updated_at = now()
WHERE id = '<payment id>';
INSERT INTO public.payment_events (payment_id, provider, status, source, payload)
SELECT id, provider, 'refunded', 'manual', '{}'::jsonb FROM public.payments WHERE id = '<payment id>';
```

3. Скорочення `paid_until` — теж вручну, якщо потрібно:
   `UPDATE public.org_subscriptions SET paid_until = '<нова дата>', updated_at = now() WHERE org_id = '<org id>';`

Вебхук `reversed` (mono) / `Refunded`, `Voided` (WayForPay) лише фіксує статус і шле Telegram-алерт; `paid_until` автоматично не скорочується.
