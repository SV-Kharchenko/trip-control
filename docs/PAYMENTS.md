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
  │     reversed  → apply_payment_reversal(): статус + подія; повне повернення зарахованого платежу
  │                 скорочує paid_until на його період (один раз) + Telegram «↩️ Повернення: …»
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

## Вебхуки: деталі

**plata by mono**
- Підпис `x-sign` (base64 DER, ECDSA SHA-256) перевіряється по сирих байтах тіла. Порожній або не-base64 `x-sign` → 401 одразу, без запиту до mono.
- Ключ: `MONO_PUBKEY` або `GET /api/merchant/pubkey`, кеш у пам'яті. Якщо підпис не зійшовся — ключ перезапитується (ротація), але **не частіше разу на 5 хв**, щоб потік підроблених запитів не ходив у mono.
- Платіж шукаємо за `invoiceId`; якщо не знайшли — запасний пошук за `reference` (= id платежу) серед платежів без `provider_invoice_id` (відповідь invoice/create могла загубитись), і `invoiceId` дописується.
- Статус застосовується, лише якщо `modifiedDate` новіший за збережений (mono не гарантує порядок).

**WayForPay**
- Підпис `merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode`. Суму WayForPay підписує так, як вона стоїть у тілі; після `JSON.parse` `250.00` стає `250`, тому підпис перевіряється з `String(amount)`, а якщо не зійшовся — з `Number(amount).toFixed(2)`. Те саме для відповіді `CHECK_STATUS`. Сума з нашою порівнюється числом.
- **На валідний запит завжди відповідаємо `accept`**, навіть якщо в нас сталася внутрішня помилка (наприклад, база тимчасово недоступна): інакше WayForPay ретраїть до 4 діб. Такий платіж лишається `pending` і дотягується пізніше — коли клієнт повертається з оплати (`/status`) або щоденним кроном: звірка платежів віком від 10 хв до **48 год** через `CHECK_STATUS`. Якщо платіж старший за 48 год і досі не зарахований — перевірити вручну в кабінеті WayForPay.

**Обидва**
- Повторні сповіщення й status-check нічого не змінюють і не дублюють Telegram-алерт.
- `success` зараховується лише при точному збігу суми й валюти. Повернення (`reversed` / `Refunded` / `Voided`) фіксується завжди — навіть якщо сума інша (часткове повернення); розбіжність лише пишеться в лог. Що робить повернення з `paid_until` — див. «Повернення коштів».

## Дані

Міграція `supabase/migrations/20261018190000_payments.sql` (на прод — лише після перевірки):
- `org_subscriptions` — `paid_until` на компанію (окрема таблиця: власник має UPDATE на `organizations`);
- `payments` — рахунки (`provider_order_id`: mono = id платежу, WayForPay = `tc-<id>`);
- `payment_events` — історія статусів, лише поля зі списку (статус, сума, валюта, дата, причина, метод, маска картки);
- RLS: платежі бачить власник; підписку — усі учасники компанії; події — ніхто з клієнтів; пише лише `service_role`;
- `apply_payment_success()` — ідемпотентне зарахування; `apply_payment_status()` — інші статуси, лише новіші;
- `current_is_approved()` бере оплату компанії через `current_org_id()`: відключений учасник оплаченої компанії доступу не має;
- `org_has_paid_access()` викликає лише сервер і SECURITY DEFINER-функції (EXECUTE тільки `service_role`);
- `org_has_user_data()` рахує `payments` і `org_subscriptions` як дані: компанію, що платила, прийняття запрошення не видаляє.

Міграція `supabase/migrations/20261020180000_refund_cut.sql`: `payments.reversal_applied_at` і `apply_payment_reversal()` (див. «Повернення коштів»).

Перевірка: `node scripts/check-payments-rls.mjs`, `node scripts/check-refund-cut.mjs` і `node scripts/check-payments-invite-compat.mjs` (усі перевірки флоу запрошень і starter-шаблону з `org_has_user_data` цієї міграції; PGlite), `npm test`.

Повний доступ (ручне `is_approved` або оплачена компанія) однаково рахують `api/calculate.js` і пошук POI в `api/poi.js` (`isDemoAccess` + `loadPaidUntil`).

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
На старті вмикаємо лише WayForPay: `MONO_*` не задаємо — plata by mono на екрані не з’являється.

Без `PAYMENTS_ENABLED=1` екрана оплати немає: клієнт після входу питає `GET /api/billing/summary` і показує пункт меню
«Тариф і оплата», банер «Продовжити» та `?billing=pay|return` лише коли `payments_enabled: true` (помилка summary = вимкнено).
Нагадування за 3 дні до кінця — лише email (Resend); Telegram отримує тільки адмін про оплату / повернення.
Секрети не логуються й не повертаються в помилках. У коді, чаті й на скрінах їх не буває.

## Тестування в sandbox

- **mono**: тестовий токен — на https://api.monobank.ua/ (розділ еквайрингу, тестовий режим). Класти **лише в Preview env**.
- **WayForPay**: тестовий мерчант і ключ — з документації WayForPay (тестові картки там же). Лише в Preview env.
- На Preview вебхуки провайдерів **не дійдуть** через Vercel Deployment Protection. Перевіряйте через
  `GET /api/billing/status?pid=` (його й так викликає екран після повернення) або увімкніть Protection Bypass for Automation
  і додайте bypass-параметр до URL вебхука.
- Сценарій: власник → меню → «Тариф і оплата» → тариф, спосіб, згода → «Оплатити» → тестова картка → повернення
  на `/?billing=return&pid=…` → «Оплату зараховано. Доступ діє до …».

## Повернення коштів

Повернення оформлюється в кабінеті провайдера (mono / WayForPay). Далі автоматично — вебхук `reversed` (mono) /
`Refunded`, `Voided` (WayForPay) або status-check → `apply_payment_reversal()`
(`supabase/migrations/20261020180000_refund_cut.sql`, рядки блокуються FOR UPDATE):

| Платіж | Повернення | Що відбувається |
|---|---|---|
| зарахований (`credited_at`) | повне | `status = reversed`; `paid_until -= period_to − period_from` цього платежу, але не нижче `now()` (і ніколи не пізніше, ніж було); `reversal_applied_at = now()` |
| зарахований | часткове | `status = reversed`; `paid_until` не змінюється; `reversal_applied_at` порожній — пізніше повне повернення ще скоротить період один раз |
| не зарахований (pending тощо) | будь-яке | лише `status = reversed`, підписка не змінюється |
| `refunded` (вручну) | будь-яке | нічого |

- Повторне сповіщення про те саме повернення (вебхук ще раз, `Voided` після `Refunded`, status-check) нічого не змінює і не шле другий алерт.
- Скорочення — рівно на тривалість періоду цього платежу. Два місяці наперед (18.10–18.11 і 18.11–18.12), повернули перший (31 день):
  18.12 − 31 день = 17.11, тобто другий оплачений період (30 днів) лишається повністю.
- Сума повернення:
  - mono — `amount − finalAmount` (якщо є `finalAmount`), інакше `amount`;
  - WayForPay — лише `refundAmount` (`amount` у сповіщенні — сума платежу). Якщо в `Refunded` / `Voided` його немає, сервер
    робить `CHECK_STATUS` (підписана відповідь) і бере `refundAmount` звідти. Якщо й там немає (або підпис / замовлення не збігаються),
    період не ріжемо (`reversal_applied_at` порожній — пізніше сповіщення з сумою ще скоротить), а адміну:
    «суму повернення не вдалося визначити, доступ не змінено — перевірте вручну».
  Часткове — лише коли сума відома й менша за суму платежу.
- mono часткове повернення приходить як `status=success` з `finalAmount < amount`: для зарахованого платежу адміну один раз
  (`payments.partial_refund_alerted_at`) «повернення часткове (N грн), доступ не змінено»; підписка й статус не змінюються.
- Telegram адміну: «↩️ Повернення: компанія · тариф · сума · провайдер · …» і в кінці нове «оплачено до DD.MM.YYYY», а коли
  оплачений доступ скінчився — «доступ завершено» або, якщо в компанії є користувач з ручним `is_approved`,
  «оплату скасовано, ручний доступ лишається». Часткове: «повернення часткове (N грн), доступ не змінено»;
  незарахований платіж: «платіж не був зарахований, доступ не змінено».
- Ручний `profiles.is_approved` повернення не чіпає: такий доступ лишається безстроковим.
- Міграція позначає платежі, уже повернені до неї (`reversed` / `refunded`), як оброблені
  (`reversal_applied_at = coalesce(updated_at, now())`): старе повторне сповіщення не ріже період і не шле алерт.
- Поки `20261020180000_refund_cut.sql` не застосована, сервер падає назад на `apply_payment_status()`: лише статус, `paid_until` не змінюється.

Ручна корекція (напр., повернення поза провайдером) — SQL від `service_role`:

```sql
UPDATE public.payments
SET status = 'refunded', refund_note = 'Повернення за запитом від DD.MM.YYYY, сума …', updated_at = now()
WHERE id = '<payment id>';
INSERT INTO public.payment_events (payment_id, provider, status, source, payload)
SELECT id, provider, 'refunded', 'manual', '{}'::jsonb FROM public.payments WHERE id = '<payment id>';
UPDATE public.org_subscriptions SET paid_until = '<нова дата>', updated_at = now() WHERE org_id = '<org id>';
```

