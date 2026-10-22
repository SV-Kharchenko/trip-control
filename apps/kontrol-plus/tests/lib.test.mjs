import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { validateClient, edrpouChecksumOk, ipnChecksumOk, ibanChecksumOk, normalizeIban } from '../src/lib/validate.js';
import { toCsv, csvFileName } from '../src/lib/csv.js';
import { monthRange, daysBetween, fmtDate, fmtPct } from '../src/lib/format.js';
import { errorText, isPlanError } from '../src/lib/errors.js';
import { totals, reportCsv, GROUPS } from '../src/views/report.js';
import { requisitesText } from '../src/views/client-card.js';
import { filterClients } from '../src/views/clients.js';

test('ЄДРПОУ checksum: real codes pass, a changed digit fails', () => {
    for (const code of ['14360570', '40075815', '21133352', '00032129', '00032106', '20077720', '43005393']) {
        assert.equal(edrpouChecksumOk(code), true, code);
    }
    assert.equal(edrpouChecksumOk('14360571'), false);
    assert.equal(edrpouChecksumOk('1436057'), false);
});

test('ІПН checksum', () => {
    assert.equal(ipnChecksumOk('3000000008'), true);
    assert.equal(ipnChecksumOk('3000000007'), false);
    assert.equal(ipnChecksumOk('300000000'), false);
});

test('IBAN mod-97 and normalization', () => {
    assert.equal(normalizeIban(' ua21 3223 1300 0002 6007 2335 6600 1 '), 'UA213223130000026007233566001');
    assert.equal(ibanChecksumOk('UA213223130000026007233566001'), true);
    assert.equal(ibanChecksumOk('UA213223130000026007233566002'), false);
    assert.equal(ibanChecksumOk('DE89370400440532013000'), true);
});

test('validateClient: only the name is required; empty fields become null', () => {
    const { data, errors, warnings } = validateClient({ name: '  Зерно  ', edrpou: '', email: '' });
    assert.deepEqual(errors, {});
    assert.deepEqual(warnings, {});
    assert.equal(data.name, 'Зерно');
    assert.equal(data.edrpou, null);
    assert.equal(data.email, null);
    assert.equal(data.vat_payer, false);
    assert.equal(validateClient({ name: '   ' }).errors.name, 'Вкажіть назву клієнта');
});

test('validateClient: format errors block, checksum problems only warn', () => {
    const bad = validateClient({ name: 'X', edrpou: '1234567', ipn: '12345', iban: 'DE89370400440532013000', email: 'a@', vat_number: '123' });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['edrpou', 'email', 'iban', 'ipn', 'vat_number']);
    const warn = validateClient({ name: 'X', legal_form: 'tov', edrpou: '1436 0571', iban: 'UA21 3223 1300 0002 6007 2335 6600 2' });
    assert.deepEqual(warn.errors, {});
    assert.ok(warn.warnings.edrpou && warn.warnings.iban);
    assert.equal(warn.data.edrpou, '14360571');
    const ok = validateClient({ name: 'ТОВ', legal_form: 'tov', edrpou: '14360570', iban: 'UA213223130000026007233566001', email: 'Buh@Zerno.UA' });
    assert.deepEqual(ok.errors, {});
    assert.deepEqual(ok.warnings, {});
    assert.equal(ok.data.email, 'buh@zerno.ua');
    assert.ok(validateClient({ name: 'ФОП', legal_form: 'fop' }).warnings.ipn);
    assert.ok(validateClient({ name: 'X', vat_payer: true }).warnings.vat_number);
    assert.equal(validateClient({ name: 'X', legal_form: 'pp' }).errors.legal_form, 'Невідома форма');
});

test('validateClient formats match the database CHECKs', () => {
    const sql = fs.readFileSync(new URL('../../../supabase/migrations/20261022091000_kontrol_plus_clients_reports.sql', import.meta.url), 'utf8');
    assert.match(sql, /edrpou ~ '\^\[0-9\]\{8\}\$'/);
    assert.match(sql, /ipn ~ '\^\[0-9\]\{10\}\$'/);
    assert.match(sql, /iban ~ '\^UA\[0-9\]\{27\}\$'/);
    assert.match(sql, /legal_form IN \('tov', 'fop', 'other'\)/);
});

test('CSV: BOM, semicolons, decimal comma, quoting, formula guard', () => {
    const csv = toCsv(['Група', 'Сума'], [['Київ; Одеса', 1234.5], ['=HYPERLINK("x")', -20], ['"Лапки"', null]]);
    assert.ok(csv.startsWith('﻿'));
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'Група;Сума');
    assert.equal(lines[1], '"Київ; Одеса";1234,5');
    assert.equal(lines[2], '"\'=HYPERLINK(""x"")";-20');
    assert.equal(lines[3], '"""Лапки""";');
    assert.equal(csvFileName('plan-fakt_logist', '2026-10-01', '2026-10-31'), 'plan-fakt_logist_2026-10-01_2026-10-31.csv');
});

test('report totals and CSV', () => {
    const rows = [
        { group_key: 'a', group_label: 'owner@a.ua', trips: 1, trips_with_fact: 1, plan_revenue: '100000', plan_costs: '80000', plan_profit: '20000',
            fact_revenue: '95000', fact_costs: '77000', fact_profit: '18000', plan_profit_with_fact: '20000', deviation_profit: '-2000', deviation_pct: '-10' },
        { group_key: 'none', group_label: 'Без клієнта', trips: 2, trips_with_fact: 1, plan_revenue: '50000', plan_costs: '45000', plan_profit: '5000',
            fact_revenue: '40000', fact_costs: '34000', fact_profit: '6000', plan_profit_with_fact: '2000', deviation_profit: '4000', deviation_pct: '200' },
    ];
    const total = totals(rows);
    assert.equal(total.trips, 3);
    assert.equal(total.plan_profit, 25000);
    assert.equal(total.deviation_profit, 2000);
    assert.equal(total.deviation_pct, 9.1);
    const csv = reportCsv(rows, 'Клієнти').slice(1).split('\r\n');
    assert.equal(csv[0], 'Клієнти;Рейсів;З фактом;План: дохід;План: витрати;План: прибуток;Факт: дохід;Факт: витрати;Факт: прибуток;Відхилення прибутку;Відхилення, %');
    assert.equal(csv[1], 'owner@a.ua;1;1;100000;80000;20000;95000;77000;18000;-2000;-10');
    assert.equal(csv[3], 'Разом;3;2;150000;125000;25000;135000;111000;24000;2000;9,1');
    assert.equal(totals([]).deviation_pct, null);
    assert.deepEqual(GROUPS.map((g) => g.value), ['logist', 'vehicle', 'client', 'direction']);
});

test('dates', () => {
    assert.deepEqual(monthRange('2026-02-14'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(monthRange('2028-02-01'), { from: '2028-02-01', to: '2028-02-29' });
    assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
    assert.equal(fmtDate('2026-10-22'), '22.10.2026');
    assert.equal(fmtPct(null), '—');
});

test('server error codes get Ukrainian messages', () => {
    assert.match(errorText({ message: 'CLIENT_LINK_FORBIDDEN', code: '42501' }), /власний рейс/);
    assert.match(errorText({ message: 'duplicate key value violates unique constraint "clients_org_edrpou_uidx"', code: '23505' }), /ЄДРПОУ/);
    assert.match(errorText({ message: 'new row violates row-level security policy', code: '42501' }), /прав/);
    assert.equal(isPlanError({ message: 'CONTROL_PLUS_REQUIRED' }), true);
    assert.equal(isPlanError({ message: 'BAD_GROUP' }), false);
});

test('requisites text and client search', () => {
    const text = requisitesText({ name: 'Зерно', legal_name: 'ТОВ «Зерно»', edrpou: '14360570', vat_payer: false, iban: 'UA213223130000026007233566001', bank_name: 'АТ Банк', signer_position: 'Директор', signer_name: 'Іваненко І. І.' });
    assert.equal(text, 'ТОВ «Зерно»\nЄДРПОУ 14360570\nНе є платником ПДВ\nIBAN UA213223130000026007233566001, АТ Банк\nПідписант: Директор Іваненко І. І.');
    const list = [{ name: 'Зерно', edrpou: '14360570' }, { name: 'Агро', phone: '+380 50', archived_at: '2026-01-01' }];
    assert.equal(filterClients(list, '1436', false).length, 1);
    assert.equal(filterClients(list, 'агро', false).length, 0);
    assert.equal(filterClients(list, 'агро', true).length, 1);
});
