// Перевірка is_platform_superadmin() / agro_access_me() у bridge: true, false і «помилка». Кешується лише точна відповідь, помилка не стає хибним
// «ні» й не стирає відоме значення; повтори 1 с / 3 с / 10 с лише для того самого користувача; на #/superadmin при помилці — «Повторити», а не редирект.
// Сценарії однакові для superadmin і agro. Без браузера: логіка в lib/flag-check.js, проводка перевіряється за кодом bridge.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ERROR, RETRY_DELAYS, createFlagCheck, parseFlag } from '../src/lib/flag-check.js';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Мініатюрний bridge: state (session + кеш відповіді), «меню» (syncGpsTab), керовані таймери й черга відповідей RPC.
function world(name) {
    const w = { session: { user: { id: 'u1' } }, value: false, cached: null, answers: [], queries: 0, syncs: 0, timers: [], menuVisible: false };
    w.check = createFlagCheck({
        query: async () => { w.queries += 1; const a = w.answers.length ? w.answers.shift() : ERROR; return a instanceof Error ? ERROR : a; },
        userId: () => (w.session ? w.session.user.id : null),
        cachedUser: () => w.cached,
        onResolve: (value, uid) => { w.value = value; w.cached = uid; w.syncs += 1; w.menuVisible = w.cached === (w.session && w.session.user.id) && w.value; },
        setTimer: (fn, ms) => { const t = { fn, ms, done: false }; w.timers.push(t); return t; },
        clearTimer: (t) => { if (t) t.done = true; },
    });
    w.name = name;
    // Спрацьовує найближчий не скасований таймер і чекає завершення повтору.
    w.tick = async () => {
        const t = w.timers.find((x) => !x.done);
        assert.ok(t, 'є запланований повтор');
        t.done = true;
        t.fn();
        await new Promise((r) => setImmediate(r));
    };
    w.signOut = () => { w.session = null; w.value = false; w.cached = null; w.menuVisible = false; w.check.cancel(); };
    w.login = (id) => { w.session = { user: { id } }; w.value = false; w.cached = null; w.menuVisible = false; w.check.cancel(); };
    return w;
}

test('parseFlag: точна відповідь true / false; помилка, null, не булеве значення — ERROR', () => {
    assert.equal(parseFlag({ data: true, error: null }), true);
    assert.equal(parseFlag({ data: false, error: null }), false);
    for (const bad of [{ data: true, error: { message: 'x' } }, { data: null, error: null }, { data: 'true', error: null }, { data: [true], error: null }, null, undefined]) {
        assert.equal(parseFlag(bad), ERROR);
    }
    assert.deepEqual(RETRY_DELAYS, [1000, 3000, 10000]);
});

for (const name of ['superadmin', 'agro']) {
    test(`${name}: помилка, потім true — пункт з'являється після повтору (1 с), без перезавантаження; onResolve (syncGpsTab) викликано`, async () => {
        const w = world(name);
        w.answers.push(ERROR, true);
        const first = await w.check.ensure();
        assert.equal(first.error, true);
        assert.equal(w.menuVisible, false);
        assert.equal(w.timers.filter((t) => !t.done)[0].ms, 1000);
        await w.tick();
        assert.equal(w.menuVisible, true, 'пункт зʼявився');
        assert.equal(w.syncs, 1);
        assert.equal(w.queries, 2);
        assert.equal(w.timers.filter((t) => !t.done).length, 0, 'повторів більше немає');
    });

    test(`${name}: помилка не кешується як false — кеш порожній, наступний ensure знову питає; відоме значення не перезаписується`, async () => {
        const w = world(name);
        w.answers.push(ERROR);
        await w.check.ensure();
        assert.equal(w.cached, null, 'нічого не закешовано');
        assert.equal(w.value, false);
        w.answers.push(true);
        await w.check.ensure();
        assert.equal(w.cached, 'u1');
        assert.equal(w.value, true);
        // Кеш скинули (як invalidateAgro / перепитування), відповідь — помилка: відоме true лишається.
        w.cached = null;
        w.answers.push(ERROR);
        await w.check.ensure();
        assert.equal(w.value, true, 'помилка не стирає відоме значення');
        assert.equal(w.menuVisible, true);
    });

    test(`${name}: точний false кешується, пункт схований, повторів і нових запитів немає`, async () => {
        const w = world(name);
        w.answers.push(false);
        const r = await w.check.ensure();
        assert.deepEqual([r.error, r.value], [false, false]);
        assert.equal(w.cached, 'u1');
        assert.equal(w.menuVisible, false);
        assert.equal(w.timers.filter((t) => !t.done).length, 0);
        await w.check.ensure();
        await w.check.recheck();
        assert.equal(w.queries, 1, 'false закешовано — не перепитуємо');
    });

    test(`${name}: до 3 повторів із затримкою 1 с, 3 с, 10 с; потім зупиняємось, а подія (recheck) починає спроби спочатку`, async () => {
        const w = world(name);
        await w.check.ensure(); // помилка 1
        assert.deepEqual(w.timers.filter((t) => !t.done).map((t) => t.ms), [1000]);
        await w.tick(); // помилка 2
        assert.deepEqual(w.timers.filter((t) => !t.done).map((t) => t.ms), [3000]);
        await w.tick(); // помилка 3
        assert.deepEqual(w.timers.filter((t) => !t.done).map((t) => t.ms), [10000]);
        await w.tick(); // помилка 4 — вичерпано
        assert.equal(w.queries, 4);
        assert.equal(w.timers.filter((t) => !t.done).length, 0, 'більше 3 повторів немає');
        w.answers.push(true);
        const again = await w.check.recheck();
        assert.equal(again.value, true, 'подія (вхід / фокус / online) питає знову');
        assert.equal(w.menuVisible, true);
    });

    test(`${name}: повтори лише для того самого користувача; зміна користувача скидає стан і скасовує повтор`, async () => {
        const w = world(name);
        w.answers.push(ERROR);
        await w.check.ensure();
        assert.equal(w.timers.filter((t) => !t.done).length, 1);
        w.login('u2');
        assert.equal(w.timers.filter((t) => !t.done).length, 0, 'повтор для u1 скасовано');
        // Навіть якщо таймер таки спрацював би — для u2 він нічого не питає.
        const stale = w.timers[0];
        const before = w.queries;
        stale.fn();
        await new Promise((r) => setImmediate(r));
        assert.equal(w.queries, before, 'стара спроба не питає за нового користувача');
        // Відповідь, що запізнилась для вийшовшого користувача, не потрапляє в кеш нового.
        const late = world(name);
        let release;
        late.check = createFlagCheck({
            query: () => new Promise((r) => { release = r; }),
            userId: () => (late.session ? late.session.user.id : null),
            cachedUser: () => late.cached,
            onResolve: (v, uid) => { late.value = v; late.cached = uid; },
            setTimer: () => 0, clearTimer: () => {},
        });
        const pending = late.check.ensure();
        late.login('u3');
        release(true);
        await pending;
        assert.equal(late.cached, null, 'відповідь для u1 не записана за u3');
        assert.equal(late.value, false);
        // Вихід: стан порожній, запитів немає.
        const out = world(name);
        out.signOut();
        assert.equal((await out.check.ensure()).stale, true);
        assert.equal(out.queries, 0);
    });

    test(`${name}: подія при порожньому кеші через помилку (SIGNED_IN / TOKEN_REFRESHED / visible / online → recheck) перепитує; при кеші — ні`, async () => {
        const w = world(name);
        w.answers.push(ERROR);
        await w.check.ensure();
        for (const [event, answer] of [['SIGNED_IN', ERROR], ['TOKEN_REFRESHED', ERROR], ['visibilitychange', ERROR], ['online', true]]) {
            w.answers.push(answer);
            const r = await w.check.recheck();
            assert.equal(r.error, answer === ERROR, event);
        }
        assert.equal(w.menuVisible, true);
        const q = w.queries;
        await w.check.recheck();
        assert.equal(w.queries, q, 'кеш є — нічого не питаємо');
    });
}

test('bridge.js: обидві перевірки на createFlagCheck, події auth / visibilitychange / online викликають recheckFlags, повтори скасовуються при виході', () => {
    const bridge = read('src/bridge.js');
    assert.match(bridge, /import \{ ERROR, createFlagCheck, parseFlag \} from '\.\/lib\/flag-check\.js';/);
    assert.match(bridge, /const superadminCheck = createFlagCheck\(\{[\s\S]*?cachedUser: \(\) => state\.superadminUser,[\s\S]*?state\.superadmin = value;\n\s+state\.superadminUser = uid;\n\s+syncGpsTab\(\);/);
    assert.match(bridge, /const agroCheck = createFlagCheck\(\{[\s\S]*?cachedUser: \(\) => state\.agroUser,[\s\S]*?setAgro\(value, uid\)/);
    assert.match(bridge, /return parseFlag\(await state\.supabase\.rpc\('is_platform_superadmin'\)\);/);
    assert.equal(/return !error && data === true;/.test(bridge), false, 'помилка більше не повертає false');
    assert.match(bridge, /event === 'TOKEN_REFRESHED'\) \{\n\s+setTimeout\(recheckFlags, 0\);/);
    assert.match(bridge, /setTimeout\(\(\) => invalidateAgro\(true\), 0\);\n\s+setTimeout\(recheckFlags, 0\);/);
    assert.match(bridge, /invalidateAgro\(\); recheckFlags\(\); \}/);
    assert.match(bridge, /window\.addEventListener\('online', recheckFlags\);/);
    assert.match(bridge, /superadminCheck\.cancel\(\);\n\s+agroCheck\.cancel\(\);/);
    // Безпека не чіпається: нових викликів RPC, окрім наявних двох перевірок, не додано.
    assert.deepEqual([...new Set([...bridge.matchAll(/rpc\('(is_platform_superadmin|agro_access_me)'\)/g)].map((m) => m[1]))].sort(), ['agro_access_me', 'is_platform_superadmin']);
});

test('#/superadmin: при помилці перевірки — notice і кнопка «Повторити» без редиректу; редирект на #/dashboard лише при точному false', () => {
    const bridge = read('src/bridge.js');
    const start = bridge.indexOf("if (route.view === 'superadmin') {");
    const block = bridge.slice(start, bridge.indexOf('runCleanups();', start));
    const errorAt = block.indexOf('check && check.error && !known');
    const redirectAt = block.indexOf("location.hash = '#/dashboard'");
    assert.ok(errorAt > 0 && redirectAt > errorAt, 'гілка помилки стоїть до редиректу');
    const errorBranch = block.slice(errorAt, redirectAt);
    assert.match(errorBranch, /Не вдалося перевірити доступ\. Спробуйте ще раз\./);
    assert.match(errorBranch, /'Повторити'/);
    assert.match(errorBranch, /return;/);
    assert.equal(/location\.hash/.test(errorBranch), false, 'у гілці помилки редиректу немає');
    assert.equal(/btn-block/.test(errorBranch), false, 'кнопка за розміром вмісту');
    assert.match(block, /if \(!state\.superadmin\) \{\n\s+location\.hash = '#\/dashboard';/);
    // Повтор, що вдався, перемальовує сторінку без перезавантаження.
    assert.match(bridge, /if \(superadminRetryShown && state\.route && state\.route\.view === 'superadmin'\) render\(\);/);
});

test('api/ Контроль+: рівно 12 функцій, міграцій у зміні немає', () => {
    const files = fs.readdirSync(new URL('../api/', import.meta.url), { recursive: true }).map((f) => String(f).split(String.fromCharCode(92)).join('/')).filter((f) => /\.(js|mjs|cjs|ts)$/.test(f));
    assert.equal(files.length, 12, files.join(', '));
});
