import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = readFileSync(
    new URL('../supabase/migrations/20261012210000_seat_reactivation_and_history_followups.sql', import.meta.url),
    'utf8'
);

function ukDaysLabelFromPage() {
    const match = html.match(/function ukDaysLabel\(value\) \{\n([\s\S]*?)\n    \}/);
    assert.ok(match, 'ukDaysLabel is missing from index.html');
    return new Function('value', match[1]);
}

const ukDaysLabel = ukDaysLabelFromPage();

test('trip length uses Ukrainian day plurals', () => {
    assert.equal(ukDaysLabel(1), 'доба');
    assert.equal(ukDaysLabel(21), 'доба');
    assert.equal(ukDaysLabel(31), 'доба');
    assert.equal(ukDaysLabel(2), 'доби');
    assert.equal(ukDaysLabel(4), 'доби');
    assert.equal(ukDaysLabel(22), 'доби');
    assert.equal(ukDaysLabel(24), 'доби');
    assert.equal(ukDaysLabel(0), 'діб');
    assert.equal(ukDaysLabel(5), 'діб');
    assert.equal(ukDaysLabel(11), 'діб');
    assert.equal(ukDaysLabel(14), 'діб');
    assert.equal(ukDaysLabel(25), 'діб');
    assert.equal(ukDaysLabel(1.5), 'доби');
    assert.equal(ukDaysLabel(0.5), 'доби');
    assert.equal(ukDaysLabel(2.5), 'доби');
    assert.equal(ukDaysLabel(4.5), 'доби');
    assert.equal(ukDaysLabel(11.5), 'доби');
    assert.equal(ukDaysLabel('2'), 'доби');
});

test('signup hint stays off Ocean and does not promise a weekly report', () => {
    assert.match(html, /Сюди надсилатимемо службові листи\./);
    assert.equal(html.includes('тижневий звіт'), false);
    const unscopedHint = html.split('\n').filter((line) =>
        line.includes('#auth-form[data-mode="signup"] .auth-email-hint') &&
        !line.includes('body.layout-studio')
    );
    assert.deepEqual(unscopedHint, []);
    assert.match(html, /body\.layout-studio\[data-theme="control"\] #auth-form\[data-mode="signup"\] \.auth-email-hint/);
    assert.match(html, /body\.layout-studio\[data-theme="paper"\] #auth-form\[data-mode="signup"\] \.auth-email-hint[\s\S]*display: block;/);
});

test('history page, client search, template confirm and atomic use count are wired', () => {
    assert.match(html, /const HISTORY_PAGE_SIZE = 50;/);
    assert.match(html, /id="client-name"/);
    assert.match(html, /fields\.client/);
    assert.match(html, /touch_route_template/);
    assert.match(html, /templateDeleteId/);
    assert.match(html, /DEMO_SAVE_LIMIT/);
    assert.equal(html.includes('use_count: next'), false);
    assert.equal(html.includes('alert('), false);
});

test('studio rates wrap at 360px without touching the ocean strip', () => {
    assert.match(html, /@media \(max-width: 400px\) \{[\s\S]*body\.layout-studio \.tc-rates-strip \{[\s\S]*flex-wrap: wrap;/);
    assert.match(html, /\.tc-rates-strip \{\s*display: inline-flex; align-items: center; flex-wrap: nowrap;/);
});

test('reactivation trigger counts seats and template use_count is a server increment', () => {
    const activation = migration.slice(
        migration.indexOf('FUNCTION public.enforce_logist_activation_limit'),
        migration.indexOf('REVOKE ALL ON FUNCTION public.enforce_logist_activation_limit')
    );
    assert.match(migration, /CREATE TRIGGER trg_enforce_logist_activation_limit/);
    assert.match(activation, /BEFORE UPDATE OF org_role, member_status, org_id|org_role = 'logist'/);
    assert.equal(activation.includes('is_service_role'), false);
    assert.match(migration, /use_count = use_count \+ 1/);
    assert.match(migration, /NEW\.client_name :=/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.touch_route_template\(uuid\) TO authenticated/);
});
