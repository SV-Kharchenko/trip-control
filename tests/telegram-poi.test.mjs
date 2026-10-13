import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { alignPoiIndexes, poiJobsFromSegments } = await import('../api/poi.js');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name, params) {
    const start = html.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, name);
    const open = html.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
        if (html[i] === '{') depth += 1;
        else if (html[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = html.slice(open + 1, i);
                return new Function(...params, body);
            }
        }
    }
    throw new Error('unclosed ' + name);
}

const plural = extractFunction('plural', ['n', 'forms']);
const telegramShareUrl = extractFunction('telegramShareUrl', ['text', 'url']);
const segments = ['відрізок', 'відрізки', 'відрізків'];
const objects = ['об’єкт', 'об’єкти', 'об’єктів'];

test('Ukrainian plural forms for segments and objects', () => {
    assert.equal(plural(0, segments), 'відрізків');
    assert.equal(plural(1, segments), 'відрізок');
    assert.equal(plural(2, segments), 'відрізки');
    assert.equal(plural(4, segments), 'відрізки');
    assert.equal(plural(5, segments), 'відрізків');
    assert.equal(plural(11, segments), 'відрізків');
    assert.equal(plural(14, segments), 'відрізків');
    assert.equal(plural(21, segments), 'відрізок');
    assert.equal(plural(22, segments), 'відрізки');
    assert.equal(plural(25, segments), 'відрізків');
    assert.equal(plural(101, objects), 'об’єкт');
    assert.equal(plural(111, objects), 'об’єктів');
    assert.equal(plural(104, objects), 'об’єкти');
});

test('telegram share URL encodes cyrillic, ampersand, hash and newline', () => {
    const text = 'Київ & Львів\n#рейс';
    const page = 'https://trip-control.com';
    const url = telegramShareUrl(text, page);
    assert.equal(
        url,
        'https://t.me/share/url?url=' + encodeURIComponent(page) + '&text=' + encodeURIComponent(text)
    );
    const query = url.slice(url.indexOf('?') + 1);
    const params = new URLSearchParams(query);
    assert.equal(params.get('url'), page);
    assert.equal(params.get('text'), text);
    assert.match(url, /%26/);
    assert.match(url, /%23/);
    assert.match(url, /%0A/);
    assert.match(url, /%D0%9A%D0%B8%D1%97%D0%B2/);
    assert.equal(url.includes('Київ'), false);
    assert.equal(url.includes('#'), false);
    assert.equal(url.includes('\n'), false);
});

test('telegram button reuses the offer text and never writes it with innerHTML', () => {
    const share = html.slice(html.indexOf('function shareTelegram()'), html.indexOf('let mapInitialized'));
    assert.match(html, /onclick="shareTelegram\(\)"/);
    assert.match(html, /Надіслати в Telegram/);
    assert.match(share, /offerShareText\(\)/);
    assert.match(share, /matchMedia\('\(pointer:coarse\)'\)/);
    assert.match(share, /navigator\.share\(\{ title: 'Розрахунок рейсу', text: text \}\)/);
    assert.match(share, /window\.open\(telegramShareUrl\(text, url\), '_blank'\)/);
    assert.match(share, /popup\.opener = null/);
    assert.match(share, /copyOfferText\(text\)/);
    assert.match(html, /showToast\('Текст скопійовано'\)/);
    assert.match(html, /document\.execCommand\('copy'\)/);
    assert.equal(share.includes('innerHTML'), false);
    assert.match(html, /class="btn full-only" type="button" onclick="shareTelegram\(\)"/);
});

test('an empty segment does not renumber the next failed or pending index', () => {
    const planned = poiJobsFromSegments([
        [{ lat: 'ні', lon: 'немає' }],
        [{ lat: 46.48, lon: 30.72 }, { lat: 46.5, lon: 30.8 }],
        [{ lat: null, lon: null }],
        [{ lat: 49.84, lon: 24.03 }]
    ]);
    assert.deepEqual(planned.jobs.map(job => job.index), [1, 3]);
    const aligned = alignPoiIndexes({
        done: [],
        failed: [{ index: 0, code: 'OVERPASS_TIMEOUT', detail: { mirror: 'm', status: 504, ms: 3 } }],
        pending: [1]
    }, planned.jobs.map(job => job.index));
    assert.equal(aligned.failed[0].index, 1);
    assert.deepEqual(aligned.pending, [3]);
});
