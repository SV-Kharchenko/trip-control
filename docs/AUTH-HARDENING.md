# Auth hardening (тиждень 2)

Частина кроків — у коді (`index.html`), частина — у **Supabase Dashboard** (ручні).

## Уже в клієнті

- Пароль при реєстрації: мін. 8 символів, є літера і цифра.
- Rate limit логіну: після кількох невдалих спроб — пауза (sessionStorage).
- Якщо Supabase вимагає підтвердження email — після signup показується підказка перевірити пошту (немає session).

## Ручні кроки в Supabase

1. **Authentication → Providers → Email**
   - Увімкніть **Confirm email** для production.
   - Site URL = `https://trip-control.com`
   - Redirect URLs: `https://trip-control.com/**`, `http://localhost:**` (для деву).

2. **Authentication → Rate Limits** (або Auth Hooks / CAPTCHA)
   - Залиште дефолтні ліміти або посиліть; опційно увімкніть CAPTCHA (hCaptcha/Turnstile).

3. **Password requirements** (Project Settings → Auth)
   - Min length ≥ 8 (узгоджено з клієнтом).

4. **MFA для admin**
   - Authentication → MFA: увімкніть TOTP.
   - Адмін увімкне MFA у своєму акаунті (Account → MFA). Окремий MFA-UI у TRIP-CONTROL поки не обов’язковий.

## Smoke

- Слабкий пароль на signup → повідомлення клієнта, запит не йде.
- 6+ невірних логінів підряд → блокування на кілька хвилин у браузері.
- З Confirm email: новий юзер без підтвердження не отримує session / бачить підказку про пошту.
