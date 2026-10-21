# Trip Control як програма (PWA)

trip-control.com встановлюється з Chrome / Edge («Встановити» в адресному рядку або «Встановити як програму» в меню
аватара) і відкривається окремим вікном. Далі — пакування в Microsoft Store через PWABuilder.

## Файли

| Файл | Що |
|---|---|
| `site.webmanifest` | id «/», name «Trip Control», short_name «TripControl», start_url «/?source=pwa», display standalone, display_override `window-controls-overlay` → `standalone`, кольори світлої теми (#F4EFE4, без білого спалаху), іконки any 180/192/512/1024 і maskable 512, 3 скріни |
| `assets/brand/icon-192.png`, `icon-maskable-512.png` | нові іконки (maskable — знак у безпечній зоні 80%) |
| `assets/pwa/*.png` | скріни для вікна встановлення: 2 wide 1280×800, 1 narrow 412×915 |
| `sw.js` | service worker, scope «/» |
| `offline.html` | сторінка «Немає зʼєднання з інтернетом» |
| `vercel.json` | `/sw.js` — `Cache-Control: no-cache`; `/site.webmanifest` — `application/manifest+json`. CSP не змінено (`worker-src 'self'` уже був) |
| `index.html` | реєстрація SW, плашка оновлення, пункт меню «Встановити як програму», заголовок вікна, режим Window Controls Overlay |

## Service worker: що кешується

- **Лише мережа (SW не перехоплює):** будь-який не-GET; `/api/*`; усе з інших доменів — Supabase, WayForPay, plata by mono,
  Google Maps, Google Fonts, CDN, НБУ; навігація з параметрами входу / оплати (`billing`, `pid`, `code`, `access_token`,
  `type`, `team_invite`, …) і `/auth`, `/callback`.
- **HTML (навігація):** мережа; без мережі — `offline.html`. HTML не кешується → після деплою завжди нова сторінка.
- **Статика свого домену** (`/assets/*` з розширенням css/js/зображення/шрифт, фавікони): cache-first у `tc-static-<VERSION>`.
  Файли з `?v=` оновлюються самі (новий URL). **`VERSION` у `sw.js` змінюйте**, коли змінились файли статики без `?v=`
  (іконки, `offline.html`) або сам `sw.js` — новий SW видалить старий кеш.
- Персональних даних у кеші немає: лише публічні файли, без відповідей із `Set-Cookie`. Вихід з акаунта в кеші SW нічого не лишає.
  У `localStorage` після виходу лишаються тема, вигляд (директор / логіст) і «Останні маршрути» під ключем конкретного користувача
  (так було й до PWA).

## Оновлення

- Новий `sw.js` → плашка «Є оновлення — Оновити» (без alert / confirm). Клік: `SKIP_WAITING` → новий SW → перезавантаження.
- Деплой без зміни `sw.js`: сторінка раз на 30 хв і при поверненні у вікно порівнює ETag «/» (Vercel змінює його з вмістом) → та сама плашка.
- Якщо не натиснути: HTML не кешується, тож наступний запуск / перезавантаження однаково відкриває нову версію.

## Вікно програми

- Заголовок «Trip Control». Пункт «Встановити як програму» видно лише після `beforeinstallprompt` і не в самій програмі.
- Оплата: перехід на сторінку WayForPay / plata by mono — у тому самому вікні програми (Chrome показує панель з адресою),
  повернення `/api/billing/return` → `/?billing=return&pid=…` — знову в межах програми. Юридичні сторінки (`target="_blank"`) — у браузері.
- Window Controls Overlay (якщо користувач сховав рядок заголовка кнопкою у вікні): смуга з назвою для перетягування, увесь вміст
  і повноекранні шари (кабінет, CRM, модалки) — під нею.

## Перевірки

- `npm test` → `tests/pwa.test.mjs`: правила SW (`/api`, Supabase, оплати, POST — не кешуються і не перехоплюються), офлайн,
  очищення старих кешів, маніфест, іконки й скріни (розміри з PNG), заголовки `vercel.json`, клієнтський код.
- Вручну після деплою на Preview: Chrome → DevTools → Application → Manifest (без попереджень), Service workers (activated);
  встановити; вхід, розрахунок, збереження, команда; оплата до сторінки WayForPay / mono і назад у вікно програми (без оплати);
  Offline-галочка → офлайн-сторінка; новий деплой → плашка оновлення.

## Microsoft Store (PWABuilder)

1. https://www.pwabuilder.com → URL `https://trip-control.com` → звіт має бути без помилок по маніфесту й SW.
2. Package For Stores → Windows → Publisher ID / Display name з Partner Center → завантажити пакет `.msixbundle`.
3. Partner Center → нова програма → завантажити пакет; опис і скріни — з `site.webmanifest`.
