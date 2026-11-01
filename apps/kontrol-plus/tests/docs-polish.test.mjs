// «Документи»: реєстр договорів, вкладка «Інше», статуси фільтра по вкладках, вирівняні номери міграцій.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TAB_STATUS_OPTIONS, statusAllowed, statusOptions, validityBadge } from '../src/lib/docs-tabs.js';
import {
    MAX_OTHER_BYTES, OTHER_CATEGORIES, contractCancelErrorText, otherErrorText, otherFileProblem, otherPath,
} from '../src/lib/other-docs.js';

const APP = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), 'utf8');
const migrations = fs.readdirSync(new URL('../../supabase/migrations/', APP));
const values = (tab) => statusOptions(tab).map(([v]) => v);

test('statuses: «Усі» has only the common ones; every tab only what its kind really has', () => {
    assert.deepEqual(values('all'), ['', 'cancelled']);
    assert.deepEqual(values(undefined), ['', 'cancelled']);
    assert.deepEqual(values('ttn'), ['', 'issued', 'cancelled']);
    assert.deepEqual(values('acts'), ['', 'issued', 'cancelled']);
    assert.deepEqual(values('invoices'), ['', 'unpaid', 'issued', 'partial', 'paid', 'overdue', 'cancelled']);
    assert.deepEqual(values('trip_sheets'), ['', 'issued', 'closed', 'cancelled']);
    assert.deepEqual(values('contracts'), ['', 'active', 'expired', 'cancelled']);
    assert.deepEqual(values('other'), ['', 'active', 'expired', 'cancelled']);
    // Оплати бувають лише в рахунків; «закрито» — лише в подорожніх листів; «діє / закінчився» — лише в договорів і «Іншого».
    for (const tab of Object.keys(TAB_STATUS_OPTIONS)) {
        for (const paid of ['unpaid', 'partial', 'paid', 'overdue']) assert.equal(statusAllowed(tab, paid), tab === 'invoices', tab + ':' + paid);
        assert.equal(statusAllowed(tab, 'closed'), tab === 'trip_sheets', tab + ':closed');
        for (const v of ['active', 'expired']) assert.equal(statusAllowed(tab, v), tab === 'contracts' || tab === 'other', tab + ':' + v);
    }
    assert.equal(statusAllowed('all', 'issued'), false);
});

test('statuses: the values are exactly what the RPCs accept', () => {
    const docsSql = read('../../supabase/migrations/20261026072759_kp_documents.sql');
    const acceptedDocs = /p_status NOT IN \(([^)]*)\)/.exec(docsSql)[1].match(/'(\w+)'/g).map((x) => x.slice(1, -1));
    for (const v of values('invoices').concat(values('acts')).filter(Boolean)) assert.ok(acceptedDocs.includes(v), 'kp_doc_list: ' + v);
    for (const file of ['20261105090000_kp_contracts_register.sql', '20261105091000_kp_other_docs.sql']) {
        const sql = read('../../supabase/migrations/' + file);
        assert.match(sql, /p_status NOT IN \('active', 'expired', 'cancelled'\)/, file);
    }
});

test('validity badge: cancelled > expired > expiring soon > active', () => {
    assert.deepEqual(validityBadge({ status: 'cancelled', expired: true }), { key: 'cancelled', label: 'Анульовано' });
    assert.deepEqual(validityBadge({ status: 'signed', expired: true }), { key: 'overdue', label: 'Закінчився' });
    assert.deepEqual(validityBadge({ status: 'draft', expiring_soon: true }), { key: 'partial', label: 'Закінчується за 30 днів' });
    assert.deepEqual(validityBadge({ status: 'draft' }), { key: 'issued', label: 'Діє' });
});

test('other files: types, size and path match the bucket policy', () => {
    const file = (name, size) => ({ name, size });
    assert.equal(otherFileProblem(file('a.pdf', 100)), null);
    assert.equal(otherFileProblem(file('a.JPG', 100)), null);
    assert.equal(otherFileProblem(file('a.docx', 100)), null);
    assert.equal(otherFileProblem(file('a.exe', 100)) !== null, true);
    assert.equal(otherFileProblem(file('a.pdf', 0)) !== null, true);
    assert.equal(otherFileProblem(file('a.pdf', MAX_OTHER_BYTES + 1)) !== null, true);
    assert.equal(otherFileProblem(null) !== null, true);
    const org = '11111111-1111-4111-8111-111111111111';
    const doc = '22222222-2222-4222-8222-222222222222';
    const path = otherPath(org, doc, 'jpeg', '33333333-3333-4333-8333-333333333333');
    assert.equal(path, org + '/' + doc + '/file-33333333-3333-4333-8333-333333333333.jpg');
    assert.deepEqual(OTHER_CATEGORIES.map(([v]) => v), ['power_of_attorney', 'insurance', 'other']);
    assert.match(otherErrorText({ message: 'OTHER_FILE_TOO_BIG' }), /10 МБ/);
    assert.match(contractCancelErrorText({ message: 'CONTRACT_REASON' }), /причину/);
});

test('migrations: new files are idempotent, manual-apply, owner-only cancel, private buckets, 10 MB', () => {
    const reg = read('../../supabase/migrations/20261105090000_kp_contracts_register.sql');
    const other = read('../../supabase/migrations/20261105091000_kp_other_docs.sql');
    for (const sql of [reg, other]) {
        assert.match(sql, /^-- Apply manually after review\. This file is not applied to production by the agent\./);
        assert.match(sql, /РУЧНИЙ ВІДКАТ/);
        assert.doesNotMatch(sql, /^\s*(DROP TABLE|TRUNCATE)\b/im, 'no DROP TABLE / TRUNCATE outside the commented rollback');
        assert.doesNotMatch(sql, /CREATE EXTENSION/i);
    }
    assert.match(reg, /ADD COLUMN IF NOT EXISTS cancelled_at/);
    assert.match(reg, /kp_docs_org\('owner'\)/);
    assert.match(other, /CREATE TABLE IF NOT EXISTS public\.kp_other_docs/);
    assert.match(other, /ENABLE ROW LEVEL SECURITY/);
    assert.match(other, /VALUES \('kp-other-docs', 'kp-other-docs', false, 10485760/);
    assert.match(other, /kp_other_docs_storage_delete[\s\S]*?public\.kp_role\(\) = 'owner'/);
    assert.match(other, /kp_other_docs_storage_insert[\s\S]*?public\.kp_can_write\(\)/);
    assert.match(other, /v_org uuid := public\.kp_docs_org\('owner'\);[\s\S]*?OTHER_REASON/);
    assert.equal((other.match(/^DROP POLICY IF EXISTS/gm) || []).length, 4);
    assert.match(other, /GRANT SELECT ON TABLE public\.kp_other_docs TO authenticated;/);
    assert.doesNotMatch(other, /GRANT (ALL|INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
});

test('migration numbers match production (kp_docs_from_requests, kp_trip_sheets)', () => {
    assert.ok(migrations.includes('20261030140232_kp_docs_from_requests.sql'));
    assert.ok(migrations.includes('20261028110121_kp_trip_sheets.sql'));
    assert.equal(migrations.some((f) => /^(20261104090000|20261029100000)_/.test(f)), false);
    const versions = migrations.map((f) => f.slice(0, 14));
    assert.equal(new Set(versions).size, versions.length, 'unique versions');
});

test('docs.js: tab wiring, no stub, no unused four-button helper, per-tab status select', () => {
    const docs = read('src/views/docs.js');
    assert.match(docs, /route\.tab === 'contracts'\) body = renderContractsTab\(app, access\)/);
    assert.match(docs, /route\.tab === 'other'\) body = renderOtherDocs\(app, access\)/);
    assert.doesNotMatch(docs, /EMPTY_TABS|STATUS_FILTERS|function createButtons\(|export \{ createButtons \}/);
    assert.match(docs, /statusOptions\(tab \|\| 'all'\)/);
    // «Додати договір» і «Додати файл» — лише на своїх вкладках.
    assert.doesNotMatch(docs, /Додати договір|Додати файл/);
    assert.match(read('src/views/docs-contracts.js'), /'Додати договір'/);
    assert.match(read('src/views/docs-other.js'), /'Додати файл'/);
});

test('contracts / other tabs: private storage, signed URLs, owner-only cancel/delete, no stretched buttons, no innerHTML', () => {
    for (const file of ['src/views/docs-contracts.js', 'src/views/docs-other.js']) {
        const code = read(file);
        assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|btn-block/, file);
        assert.doesNotMatch(code, /getPublicUrl/, file);
    }
    const other = read('src/views/docs-other.js');
    assert.match(other, /createSignedUrl\(path, OTHER_URL_SECONDS\)/);
    assert.match(other, /access\.isOwner && r\.status === 'active' \? reasonCancel/);
    assert.match(other, /access\.isOwner \? confirmButton\('Видалити'/);
    assert.match(other, /access\.canWrite \? h\('div', \{ class: 'toolbar' \}/);
    const contracts = read('src/views/docs-contracts.js');
    assert.match(contracts, /access\.isOwner && r\.status !== 'cancelled'/);
    assert.match(contracts, /kp_contract_list_all/);
    assert.match(contracts, /CONTRACT_BUCKET/);
});

test('cancelled contract: human status name, no send / sign controls in the UI, server refuses', async () => {
    const { CONTRACT_STATUS, contractErrorText } = await import('../src/lib/contracts.js');
    assert.equal(CONTRACT_STATUS.cancelled, 'Анульовано');
    assert.match(contractErrorText({ message: 'CONTRACT_CANCELLED' }), /анульовано/);
    const view = read('src/views/contracts.js');
    assert.match(view, /const mail = writable && c\.file_path && c\.status !== 'cancelled'/);
    // Підпис, КЕП, скан і зміна показуються лише для чернетки (locked = status !== 'draft').
    assert.match(view, /const locked = c\.status !== 'draft';/);
    assert.equal((view.match(/writable && !locked/g) || []).length >= 5, true);
    const sql = read('../../supabase/migrations/20261106090000_kp_contract_cancelled_guards.sql');
    assert.match(sql, /^-- Apply manually after review\./);
    assert.match(sql, /kp_contract_email_context[\s\S]*?v_c\.status = 'cancelled'[\s\S]*?CONTRACT_CANCELLED/);
    assert.match(sql, /kp_mail_reserve[\s\S]*?c\.status = 'cancelled'[\s\S]*?CONTRACT_CANCELLED/);
    // Підписання вже відмовляє для не-чернетки в самій базі.
    const base = read('../../supabase/migrations/20261102090000_kp_contracts.sql');
    assert.equal((base.match(/status <> 'draft'/g) || []).length >= 5, true);
});

test('other files: orphan cleanup on the client, author may delete an unrecorded own file, file first then record', () => {
    const view = read('src/views/docs-other.js');
    assert.match(view, /if \(error\) \{[\s\S]*?storage\.from\(OTHER_BUCKET\)\.remove\(\[path\]\)[\s\S]*?return clear\(status, notice\(otherErrorText\(error\)\)\);/);
    assert.ok(view.indexOf(".remove([r.file_path])") > 0 && view.indexOf(".remove([r.file_path])") < view.indexOf("rpc('kp_other_delete'"), 'file is removed before the record');
    const sql = read('../../supabase/migrations/20261105091000_kp_other_docs.sql');
    assert.match(sql, /owner_id = auth\.uid\(\)::text AND NOT EXISTS \(SELECT 1 FROM public\.kp_other_docs AS d WHERE d\.file_path = storage\.objects\.name\)/);
    assert.match(sql, /OTHER_FILE_STILL_THERE/);
    assert.match(sql, /kp_other_delete[\s\S]*?FROM storage\.objects AS o WHERE o\.bucket_id = 'kp-other-docs' AND o\.name = v_path[\s\S]*?DELETE FROM public\.kp_other_docs WHERE id = p_id/);
});

test('kp-other-docs storage policies use the same organisation function everywhere', () => {
    const sql = read('../../supabase/migrations/20261105091000_kp_other_docs.sql');
    const policies = sql.slice(sql.indexOf('CREATE POLICY kp_other_docs_storage_select'), sql.indexOf('-- RPC'));
    assert.equal((policies.match(/public\.kp_org_id\(\)::text/g) || []).length, 3);
    assert.doesNotMatch(policies, /current_org_id/);
});
