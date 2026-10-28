import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    buildWeeklyReport,
    previousWeekRange,
    reportRecipient,
    factIsAlert,
    mailProvider,
    cronAuthorized,
    deliverReport
} from '../lib/weekly-report.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api/weekly-report.js', import.meta.url), 'utf8');
const migration = readFileSync(
    new URL('../supabase/migrations/20261012230000_weekly_reports.sql', import.meta.url),
    'utf8'
);
const grants = readFileSync(
    new URL('../supabase/migrations/20261012231000_weekly_reports_grants.sql', import.meta.url),
    'utf8'
);
const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');

const weekTrips = [
    {
        tripDate: '2026-10-06',
        routeFrom: 'Умань',
        routeTo: 'Ізмаїл',
        clientName: 'Агросвіт',
        status: 'accepted',
        revenue: 39160,
        profit: 8420,
        actualProfit: 7000
    },
    {
        tripDate: '2026-10-08',
        routeFrom: 'Київ',
        routeTo: 'Львів',
        clientName: 'Захід Транс',
        status: 'draft',
        revenue: 95760,
        profit: -3200,
        actualProfit: null
    }
];

test('previous week is Monday–Sunday in Kyiv, even early Monday', () => {
    assert.deepEqual(previousWeekRange(new Date('2026-10-14T12:00:00+03:00')), {
        start: '2026-10-05',
        end: '2026-10-11'
    });
    assert.deepEqual(previousWeekRange(new Date('2026-10-12T00:30:00+03:00')), {
        start: '2026-10-05',
        end: '2026-10-11'
    });
    assert.deepEqual(previousWeekRange(new Date('2026-10-11T20:30:00Z')), {
        start: '2026-09-28',
        end: '2026-10-04'
    });
    assert.deepEqual(previousWeekRange(new Date('2026-11-02T08:00:00+02:00')), {
        start: '2026-10-26',
        end: '2026-11-01'
    });
});

test('report address prefers the cabinet mailbox, then the signup email', () => {
    assert.equal(reportRecipient(' reports@firm.ua ', 'owner@firm.ua'), 'reports@firm.ua');
    assert.equal(reportRecipient('не пошта', 'owner@firm.ua'), 'owner@firm.ua');
    assert.equal(reportRecipient('', ''), '');
    assert.equal(reportRecipient('a@b', 'also-bad'), '');
});

test('the digest uses saved plan and fact, and flags the same 10% gap', () => {
    const report = buildWeeklyReport({
        orgName: 'Агросвіт',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-11',
        trips: weekTrips,
        alertPct: 10
    });
    assert.equal(report.summary.tripCount, 2);
    assert.equal(report.summary.factCount, 1);
    assert.equal(report.summary.alertCount, 1);
    assert.equal(report.summary.plannedProfit, 5220);
    assert.equal(report.summary.actualProfit, 7000);
    assert.equal(factIsAlert(7000, 8420, 10), true);
    assert.match(report.text, /Умань → Ізмаїл/);
    assert.match(report.text, /Київ → Львів/);
    assert.match(report.text, /відхилення/);
    assert.match(report.text, /Калькулятор рейси не перераховував/);
    assert.equal(report.text.includes('/api/calculate'), false);
    assert.equal(report.html.includes('<script'), false);
});

test('a zero plan with a real fact is an alert, and a long week is trimmed', () => {
    assert.equal(factIsAlert(5, 0, 10), true);
    assert.equal(factIsAlert(0, 0, 10), false);
    const trips = Array.from({ length: 41 }, (_, i) => ({
        tripDate: '2026-10-06',
        routeFrom: 'А',
        routeTo: 'Б' + i,
        status: 'done',
        profit: 10,
        actualProfit: null
    }));
    const report = buildWeeklyReport({
        orgName: '<b>Зла</b>',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-11',
        trips,
        alertPct: 'nope'
    });
    assert.equal(report.summary.tripCount, 41);
    assert.match(report.text, /І ще 1 рейс\./);
    assert.match(report.html, /&lt;b&gt;Зла&lt;\/b&gt;/);
    assert.equal(report.alertPct, 10);
});

test('mail and cron stay closed without their env', async () => {
    assert.equal(mailProvider({}), null);
    assert.equal(mailProvider({ RESEND_API_KEY: 're_test', REPORT_FROM_EMAIL: 'not-an-email' }), null);
    assert.equal(cronAuthorized('Bearer secret', ''), false);
    assert.equal(cronAuthorized('', 'secret'), false);
    assert.equal(cronAuthorized('Bearer secret', 'secret'), true);
    assert.equal(cronAuthorized('Bearer secret-x', 'secret-y'), false);
    let called = false;
    await assert.rejects(
        () => deliverReport({ to: 'a@b.ua', subject: 's', text: 't' }, {
            env: {},
            fetch: () => { called = true; return { ok: true, json: async () => ({}) }; }
        }),
        (error) => error.code === 'REPORT_MAIL_UNCONFIGURED'
    );
    assert.equal(called, false);
    const seen = [];
    const sent = await deliverReport({
        to: 'owner@firm.ua',
        subject: 'Тема\nінша',
        text: 'тіло',
        html: '<p>тіло</p>'
    }, {
        env: { RESEND_API_KEY: 're_test_key', REPORT_FROM_EMAIL: 'TRIP-CONTROL <reports@trip-control.com>' },
        fetch: async (url, init) => {
            seen.push({ url, init });
            return { ok: true, json: async () => ({ id: 'email_1' }) };
        }
    });
    assert.equal(sent.id, 'email_1');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.resend.com/emails');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer re_test_key');
    const body = JSON.parse(seen[0].init.body);
    assert.deepEqual(body.to, ['owner@firm.ua']);
    assert.equal(body.subject.includes('\n'), false);
});

test('the page previews and sends through the report API, not the calculator', () => {
    assert.match(html, /id="weekly-report-box"/);
    assert.match(html, /previewWeeklyReport\(/);
    assert.match(html, /sendWeeklyReport\(/);
    assert.match(html, /\/api\/weekly-report/);
    const hint = html.match(/id="auth-email-hint">([^<]*)</);
    assert.equal(hint && hint[1], 'Сюди надсилатимемо службові листи.');
    const previewBody = html.slice(
        html.indexOf('async function previewWeeklyReport'),
        html.indexOf('async function sendWeeklyReport')
    );
    const sendBody = html.slice(
        html.indexOf('async function sendWeeklyReport'),
        html.indexOf('function openCabinet()')
    );
    assert.equal(previewBody.includes('/api/calculate'), false);
    assert.equal(previewBody.includes('calculate('), false);
    assert.equal(sendBody.includes('/api/calculate'), false);
    assert.equal(sendBody.includes('calculate('), false);
    assert.match(previewBody, /weeklyReportRequest\('preview'\)/);
    assert.match(sendBody, /weeklyReportRequest\('send'\)/);
    assert.match(api, /REPORT_MAIL_UNCONFIGURED/);
    assert.equal(api.includes('/api/calculate'), false);
    assert.equal(api.includes('calculate.js'), false);
    assert.match(migration, /UNIQUE \(org_id, period_start\)/);
    assert.match(migration, /FOR SELECT TO authenticated/);
    assert.equal(migration.includes('FOR INSERT'), false);
    assert.match(grants, /REVOKE ALL ON TABLE public\.weekly_reports FROM PUBLIC, anon, authenticated/);
    assert.match(grants, /GRANT SELECT ON TABLE public\.weekly_reports TO authenticated/);
    assert.match(vercel, /\/api\/weekly-report/);
    assert.match(vercel, /0 6 \* \* 1/);
});
