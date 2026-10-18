# Юридичні сторінки та згода

## Де лежать тексти

| Документ | Файл | Адреса |
|----------|------|--------|
| Публічна оферта | `legal/offer.html` | https://trip-control.com/offer |
| Політика конфіденційності | `legal/privacy.html` | https://trip-control.com/privacy |
| Оплата та повернення коштів | `legal/payment-refund.html` | https://trip-control.com/payment-refund |

Кожен файл — повна сторінка-обгортка (head, тема, стилі, футер). Сам текст документа — тільки всередині
`<article class="legal-doc">…</article>`. Обгортку при правці тексту не чіпайте.

Маркери `<mark>[ПЕРЕВІРИТИ…]</mark>` — місця, які треба звірити з договорами; прибираються вручну.

## Адреси

- `vercel.json` → `rewrites`: `/offer`, `/privacy`, `/payment-refund` віддають відповідні `legal/*.html`.
- Старі адреси `/legal/offer.html`, `/legal/privacy.html` працюють як і раніше; `canonical` на сторінках веде на короткі.
- `sitemap.xml` містить лише короткі адреси.
- У застосунку всі посилання — на короткі адреси.

## Як оновити редакцію

1. Змініть текст усередині `<article class="legal-doc">` і дату «Редакція від …» у самому документі.
2. Якщо змінилась оферта або політика конфіденційності — нова дата стає новою версією згоди:
   - `LEGAL_VERSION` в `index.html` (поруч з `handleAuth`);
   - `LEGAL_VERSION` в `lib/legal.js`;
   - нова міграція з `CREATE OR REPLACE FUNCTION public.record_signup_consent()`, де в `v_allowed` додано нову дату
     (стару можна лишити на час переходу). Без цього згода з новою датою не запишеться (реєстрація при цьому не ламається).
3. `npm test` — `tests/legal-pages.test.mjs` звіряє версії в `index.html`, `lib/legal.js` і міграції.

## Футер

Один компонент `.tc-legal-footer` з однаковою розміткою на екрані входу, у меню користувача, внизу калькулятора/огляду,
унизу кабінету, на трьох юридичних сторінках і на `404.html`. Стилі — `assets/legal-footer.css` (через CSS-змінні теми).

Платіжні логотипи: поки в `assets/payments/` немає офіційних SVG, показуються текстові бейджі «VISA» / «Mastercard».
Коли з'являться `assets/payments/visa.svg` і `assets/payments/mastercard.svg` (офіційні, з brand-гайдів Visa / Mastercard),
замініть бейджі на `<img>` в усіх місцях з футером.

## Згода при реєстрації

- Чекбокс «Погоджуюсь з Публічною офертою та Політикою конфіденційності» — не відмічений за замовчуванням; без нього
  реєстрація (звичайна і за запрошенням) не відправляється.
- `supabase.auth.signUp` передає в `options.data` `consent_offer_version` і `consent_privacy_version` = `LEGAL_VERSION`.
- Тригер `on_auth_user_record_signup_consent` (функція `public.record_signup_consent()`, міграція
  `20261018100000_legal_consents.sql`) пише рядок `kind = 'signup'` у `public.legal_consents` з часом сервера, якщо обидві
  версії є в дозволеному списку. Інакше нічого не пише і реєстрацію не ламає.
- `public.legal_consents`: користувач бачить лише свої рядки; писати може тільки `service_role` або тригер. IP не зберігається.
- `kind = 'payment'` і `payment_id` — для майбутньої згоди при оплаті (не в цьому PR).
- Перевірка: `node scripts/check-legal-consents.mjs` (PGlite).

Нових змінних оточення немає.
