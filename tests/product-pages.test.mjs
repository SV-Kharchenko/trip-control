// Публічні сторінки продуктів /kontrol-plus і /park-control: рендер (структура, SEO, CTA), пункти меню сайту, маршрути, sitemap, мокапи без зовнішніх картинок,
// кнопки за розміром вмісту й guard: у нових файлах немає назв реальних компаній-клієнтів.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const kp = read('landing/kontrol-plus.html');
const pc = read('landing/park-control.html');
const css = read('assets/product-pages.css');
const js = read('assets/product-pages.js');
const index = read('index.html');
const vercel = JSON.parse(read('vercel.json'));
const sitemap = read('sitemap.xml');

const PAGES = [
    { name: 'Контроль+', file: 'landing/kontrol-plus.html', html: kp, path: '/kontrol-plus' },
    { name: 'Park-Control', file: 'landing/park-control.html', html: pc, path: '/park-control' }
];
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

for (const page of PAGES) {
    test(page.name + ': один h1, свій title, description ≤160, og/twitter, canonical, lang', () => {
        const { html } = page;
        assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
        assert.match(html, /<html lang="uk"/);
        const title = html.match(/<title>([^<]+)<\/title>/)[1];
        assert.ok(title.includes(page.name), title);
        const description = html.match(/<meta name="description" content="([^"]+)">/)[1];
        assert.ok(description.length > 40 && description.length <= 160, String(description.length));
        assert.match(html, new RegExp('<link rel="canonical" href="https://trip-control\\.com' + page.path.replace('+', '\\+') + '">'));
        assert.match(html, new RegExp('<meta property="og:url" content="https://trip-control\\.com' + page.path.replace('+', '\\+') + '">'));
        for (const tag of ['og:title', 'og:description', 'og:image', 'og:type']) assert.match(html, new RegExp('<meta property="' + tag + '" content="[^"]+">'));
        for (const tag of ['twitter:title', 'twitter:description', 'twitter:image']) assert.match(html, new RegExp('<meta name="' + tag + '" content="[^"]+">'));
        assert.ok(html.match(/<h1>([^<]+)<\/h1>/)[1].includes(page.name));
    });

    test(page.name + ': hero → для кого → можливості → як це працює → ролі → FAQ (4–6) → фінальний CTA', () => {
        const { html } = page;
        const order = ['kp-hero"', 'id="who"', 'id="features"', 'id="how"', 'id="roles"', 'id="faq"', 'id="start"'].map((m) => html.indexOf(m));
        assert.ok(order.every((n) => n > 0), order.join());
        assert.deepEqual([...order].sort((a, b) => a - b), order);
        const faq = html.slice(html.indexOf('id="faq"'), html.indexOf('id="start"'));
        const questions = (faq.match(/<details>/g) || []).length;
        assert.ok(questions >= 4 && questions <= 6, 'питань: ' + questions);
        const steps = (html.match(/<ol class="kp-steps">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length;
        assert.ok(steps >= 3 && steps <= 4, 'кроків: ' + steps);
    });

    test(page.name + ': тема лише light/dark, шапка з активним пунктом, футер, без зовнішніх картинок і слова «калькулятор»', () => {
        const { html } = page;
        assert.match(html, /<html lang="uk" data-theme="light">/);
        assert.match(css, /\[data-theme="light"\]/);
        assert.match(css, /\[data-theme="dark"\]/);
        assert.equal(/data-theme="(?!light"|dark")/.test(html), false);
        const nav = html.match(/<nav class="kp-nav"[\s\S]*?<\/nav>/)[0];
        assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
        assert.match(nav, new RegExp('<a href="' + page.path.replace('+', '\\+') + '" aria-current="page">' + page.name.replace('+', '\\+') + '</a>'));
        assert.match(nav, /<a href="\/kontrol-plus"[^>]*>Контроль\+<\/a>/);
        assert.match(nav, /<a href="\/park-control"[^>]*>Park-Control<\/a>/);
        const footer = html.match(/<footer class="tc-legal-footer">[\s\S]*?<\/footer>/)[0];
        for (const value of ['mailto:support@trip-control.com', 'href="/park-control"', 'href="/kontrol-plus"', 'href="/privacy"']) assert.ok(footer.includes(value), value);
        assert.equal(/<img[\s>]/i.test(html), false, 'мокапи — HTML/CSS, без картинок');
        assert.equal(/url\(\s*['"]?https?:/i.test(css), false);
        assert.match(html, /class="mk"[^>]*role="img" aria-label="Умовний приклад/);
        assert.equal(/калькулятор/i.test(visible(html)), false);
        assert.match(html, /<link rel="stylesheet" href="\/assets\/product-pages\.css\?v=[\d-]+">/);
        assert.match(html, /<script src="\/assets\/product-pages\.js\?v=[\d-]+" defer><\/script>/);
    });
}

test('Контроль+: можливості, ролі в UI, CTA «Спробувати» / «Увійти» → app.trip-control.com', () => {
    for (const text of ['Для кого', 'Директори транспортних компаній', 'Логісти', 'Диспетчери', 'ФОП-власники вантажівок',
        'Розрахунок рейсу', 'маршрути Google'.replace('м', 'М'), 'альтернативними варіантами', 'Заявки з погодженням', 'Автопарк', 'норми витрати пального', 'Подорожні листи',
        'Акти, рахунки, договори', 'підписом і печаткою', 'GPS-моніторинг', 'Wialon', 'Команда з правами', 'Статистика', 'PWA']) assert.ok(kp.includes(text), text);
    const roles = kp.slice(kp.indexOf('id="roles"'), kp.indexOf('id="price"'));
    assert.deepEqual([...roles.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Директор', 'Менеджер', 'Логіст']);
    const hero = kp.slice(kp.indexOf('kp-hero"'), kp.indexOf('id="who"'));
    assert.match(hero, /<a class="btn" href="https:\/\/app\.trip-control\.com">Спробувати<\/a>/);
    assert.match(hero, /<a class="btn btn-ghost" href="https:\/\/app\.trip-control\.com">Увійти<\/a>/);
    const finale = kp.slice(kp.indexOf('id="start"'), kp.indexOf('id="demo"'));
    assert.ok(finale.includes('>Спробувати</a>') && finale.includes('>Увійти</a>') && finale.includes('https://app.trip-control.com'));
    assert.equal(kp.includes('agro.trip-control.com'), false);
    // Раніше наявні блоки лишились: ціна, доопрацювання, форма демо.
    for (const id of ['price', 'custom', 'demo']) assert.match(kp, new RegExp('id="' + id + '"'));
});

test('Park-Control: позиціонування, п’ять ролей, CTA «Увійти» → agro.trip-control.com і заявка через наявний /api/kp-lead', () => {
    for (const text of ['автопарк', 'техніка', 'підрозділ', 'Заявки підрозділів на транспорт', 'Ремонти й відповідальні', 'GPS-контроль', 'Звітність для керівництва', 'агробізнес', 'холдинг']) {
        assert.ok(pc.toLowerCase().includes(text.toLowerCase()), text);
    }
    const roles = pc.slice(pc.indexOf('id="roles"'), pc.indexOf('id="faq"'));
    assert.deepEqual([...roles.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Директор', 'Менеджер', 'Логіст', 'Відповідальний за ремонти', 'Замовник підрозділу']);
    const hero = pc.slice(pc.indexOf('kp-hero"'), pc.indexOf('id="who"'));
    assert.match(hero, /<a class="btn" href="https:\/\/agro\.trip-control\.com">Увійти<\/a>/);
    assert.match(hero, /<a class="btn btn-ghost" href="#access">Залишити заявку на доступ<\/a>/);
    assert.match(pc, /id="access"/);
    assert.match(pc, /<form id="kp-form" data-lead-endpoint="\/api\/kp-lead" data-lead-prefix="\[Park-Control/);
    for (const name of ['name', 'company', 'phone', 'email', 'vehicles', 'comment', 'website', 'consent']) assert.match(pc, new RegExp('name="' + name + '"'));
    assert.equal(pc.includes('app.trip-control.com'), false);
    assert.match(js, /'\/api\/kp-lead'/);
    assert.equal(/api\/(?!kp-lead)/.test(js), false, 'нових ендпоінтів немає');
});

test('меню сайту: «Контроль+» і «Park-Control» у шапці лендингу (desktop і мобільне), решта пунктів на місці', () => {
    const head = index.slice(index.indexOf('<header class="lp-site-head">'), index.indexOf('<main id="lp-top">'));
    const desktop = head.match(/<nav class="lp-site-nav"[\s\S]*?<\/nav>/)[0];
    const mobile = head.match(/<nav class="lp-mnav"[\s\S]*?<\/nav>/)[0];
    for (const nav of [desktop, mobile]) {
        assert.match(nav, /<a href="\/kontrol-plus"[^>]*>Контроль\+<\/a>/);
        assert.match(nav, /<a href="\/park-control"[^>]*>Park-Control<\/a>/);
        for (const label of ['Спробувати розрахунок', 'Приклад', 'Можливості', 'Для кого', 'Тарифи', 'Питання']) assert.ok(nav.includes('>' + label + '</a>'), label);
    }
    // Бургер з’являється до 1180px, щоб довше меню не вилазило на планшеті (1024).
    const landingCss = read('assets/landing.css');
    assert.match(landingCss, /@media \(max-width: 1180px\) \{\s*#landing-screen \.lp-site-nav \{ display: none; \}/);
    assert.match(landingCss, /@media \(max-width: 1180px\) \{\s*#landing-screen \.lp-burger \{ display: inline-flex; \}/);
    assert.match(landingCss, /@media \(min-width: 1181px\) \{\s*#landing-screen \.lp-mnav \{ display: none !important; \}/);
});

test('маршрути й sitemap: /kontrol-plus і /park-control, без нових serverless-функцій', () => {
    assert.deepEqual(vercel.rewrites.find((r) => r.source === '/park-control'), { source: '/park-control', destination: '/landing/park-control.html' });
    assert.deepEqual(vercel.rewrites.find((r) => r.source === '/kontrol-plus'), { source: '/kontrol-plus', destination: '/landing/kontrol-plus.html' });
    for (const path of ['/kontrol-plus', '/park-control']) assert.match(sitemap, new RegExp('<loc>https://trip-control\\.com' + path.replace('+', '\\+') + '</loc>\\s*<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>'));
    const fns = readdirSync(new URL('../api/', import.meta.url), { recursive: true }).map(String).filter((f) => /\.(js|mjs|cjs|ts)$/.test(f.replace(/\\/g, '/')) && !f.replace(/\\/g, '/').split('/').some((p) => p.startsWith('_')));
    assert.ok(fns.length <= 12, 'функцій у api/: ' + fns.length);
    assert.equal(fns.length, 11, 'сторінки не додали функцій');
});

test('кнопки за розміром вмісту: .btn не на всю ширину, width:100% лише в явному .btn-block, якого в розмітці сторінок немає', () => {
    const btn = css.match(/\n\.btn \{[^}]*\}/)[0];
    assert.match(btn, /display: inline-block; width: auto;/);
    assert.equal(/width: 100%/.test(btn), false);
    assert.match(css, /\.btn-block \{ display: block; width: 100%; \}/);
    for (const page of PAGES) assert.equal(page.html.includes('btn-block'), false, page.file);
    assert.match(css, /@media \(max-width: 600px\)/);
    assert.match(css, /@media \(max-width: 1100px\)/);
    assert.match(css, /@media \(min-width: 1600px\)/);
});

// Guard: назви реальних компаній-клієнтів не мають потрапляти в нові файли (тексти, alt, мета-теги, код, коментарі).
// Шаблони зібрано з фрагментів, щоб сам тест не містив заборонених рядків.
const FORBIDDEN = [
    new RegExp('а[\\s\\-_]*гр' + 'ейн', 'i'), new RegExp('a[\\s\\-_]*gr' + 'ain', 'i'), new RegExp('агр' + 'ейн', 'i'),
    new RegExp('агро' + 'контроль', 'i'), new RegExp('agro' + '[\\s\\-_]*control', 'i'), new RegExp('agr' + 'ein', 'i')
];
const NEW_FILES = ['landing/park-control.html', 'landing/kontrol-plus.html', 'assets/product-pages.css', 'assets/product-pages.js', 'tests/product-pages.test.mjs'];

test('guard: у нових файлах немає назв реальних компаній-клієнтів', () => {
    for (const file of NEW_FILES) {
        const text = read(file);
        for (const re of FORBIDDEN) assert.equal(re.test(text), false, file + ' містить заборонену назву (' + re + ')');
    }
    // Самі шаблони справді ловлять заборонені варіанти (інакше guard порожній).
    const samples = ['А-' + 'Грейн', 'A-' + 'Grain', 'Аг' + 'рейн Транс', 'Агро' + 'контроль'];
    for (const sample of samples) assert.ok(FORBIDDEN.some((re) => re.test(sample)), sample);
});
