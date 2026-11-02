# Аудит SECURITY DEFINER-функцій і таблиць (перед запуском)

Вибірка знята зі справжнього Postgres (PGlite) після застосування **всіх** міграцій репозиторію (`apps/kontrol-plus/db/check-db.mjs`):
`pg_proc` (SECURITY DEFINER у схемі `public`) × `has_function_privilege` для `authenticated` / `anon`, `pg_class.relrowsecurity` × `pg_policies`.

## Підсумок

- SECURITY DEFINER-функцій у `public`: **210**, з них тригерних (EXECUTE не потрібен, напряму не викликаються) — 47; викликається клієнтами (EXECUTE має `authenticated` або `anon`) — **107**.
- Усі SECURITY DEFINER мають `SET search_path` (перевірено запитом по `pg_proc.proconfig`: функцій без нього — 0).
- Знайдено **дір: 2** (одна функція, одна таблиця); обидві закриває міграція `20261110091000_security_audit_fixes.sql`.
- `anon` має EXECUTE лише на одну функцію — `bump_calc_usage` (дірка, закрито); після міграції — на жодну.
- Таблиць з RLS без політик: **14** — усі навмисно «deny all» для клієнтів (див. нижче), дірок немає.

## Функції (викликаються клієнтами)

| функція | чим перевіряє org / роль | висновок |
|---|---|---|
| `api_rate_hit(p_bucket text, p_limit integer, p_window_seconds integer)` | лише service_role (нова, 20261110090000); клієнти не мають EXECUTE | OK |
| `bump_calc_usage(p_org uuid, p_limit integer)` **(anon!)** | приймає p_org від викликача; EXECUTE мали anon / authenticated (REVOKE був лише з PUBLIC) | **дірка** → закрито 20261110091000: лише service_role |
| `client_history(p_client uuid)` | kp_org_id() + kp_trip_visible(user_id); клієнт лише своєї організації | OK |
| `current_org_id()` | auth.uid() → активний профіль, організація не blocked | OK |
| `current_org_is_control_plus()` | current_org_id() | OK |
| `gps_map_vehicle(p_gps_vehicle uuid, p_vehicle uuid)` | current_org_id() + kp_role(); авто лише своєї організації | OK |
| `gps_units()` | kp_org_id(); лише GPS-пристрої своєї організації | OK |
| `is_org_owner()` | current_org_role() поточного користувача | OK |
| `is_platform_admin()` | auth.uid(): повертає лише bool для самого викликача (profiles.role) | OK |
| `is_user_blocked()` | auth.uid(): лише про самого викликача | OK |
| `kp_calc_accepted_list(p_q text)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_calc_doc_prefill(p_calculation uuid)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_calc_documents(p_calculation uuid)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_calc_is_accepted(p_calculation uuid)` | current_org_id() + службова роль; рейс лише своєї організації | OK |
| `kp_can_link(p_calc uuid)` | auth.uid() + kp_role(); рейс лише з org_id = current_org_id() | OK |
| `kp_can_write()` | kp_org_id() + kp_role() | OK |
| `kp_client_debts(p_on date)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_company_settings_merge(p_set jsonb, p_remove text[])` | auth.uid() + current_org_id() + is_org_owner(); патч лише у свій org (нова, 20261110092000) | OK |
| `kp_context()` | kp_org_id() + current_org_id() + kp_role(): повертає роль і організацію самого викликача | OK |
| `kp_contract_cancel(p_id uuid, p_reason text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_contract_email_context(p_id uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_contract_list(p_client uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_contract_list_all(p_client uuid, p_from date, p_to date, p_status text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_contract_save(p_id uuid, p_client uuid, p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_contract_scan_context(p_id uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_contract_sign_context(p_id uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_doc_assets_source()` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_doc_cancel(p_doc uuid, p_reason text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_doc_create(p_kind text, p_client uuid, p_doc_date date, p_currency text, p_number)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_doc_email_context(p_doc uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_doc_email_log(p_doc uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_doc_get(p_doc uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_doc_list(p_kind text, p_from date, p_to date, p_client uuid, p_status text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_doc_next_number(p_kind text, p_doc_date date)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_doc_sign(p_doc uuid, p_signed boolean)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_doc_signed(p_ids uuid[])` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_doc_trips_for_client(p_client uuid, p_from date, p_to date, p_kind text)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_driver_details_get(p_driver uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_driver_details_save(p_driver uuid, p_phone text, p_passport text, p_ipn text, p_address te)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_driver_list(p_active_only boolean)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_driver_save(p_id uuid, p_full_name text, p_license_no text, p_active boolean)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_maintenance_override_clear(p_vehicle uuid, p_type uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_maintenance_override_set(p_vehicle uuid, p_type uuid, p_interval_km integer, p_interval_months )` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_maintenance_seed_defaults()` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_maintenance_status(p_vehicle uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_maintenance_type_archive(p_id uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_maintenance_type_upsert(p_id uuid, p_name text, p_interval_km integer, p_interval_months integ)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_odometer_add(p_vehicle uuid, p_read_on date, p_odometer integer, p_note text)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_odometer_list(p_vehicle uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_org_id()` | auth.uid() + current_org_id() + план Контроль+ | OK |
| `kp_other_cancel(p_id uuid, p_reason text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_other_delete(p_id uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_other_list(p_from date, p_to date, p_category text, p_client uuid, p_status text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_other_save(p_id uuid, p_data jsonb)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_part_history(p_part uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_part_receive(p_part uuid, p_qty numeric, p_unit_price numeric, p_date date, p_suppl)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_part_upsert(p_id uuid, p_name text, p_article text, p_unit text, p_min_qty numeric)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_parts_import(p_rows jsonb, p_commit boolean)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_payment_add(p_doc uuid, p_paid_on date, p_amount numeric, p_note text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_payment_void(p_payment uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_receipt_reverse(p_receipt uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_cost_per_km(p_from date, p_to date, p_vehicle uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_handler_add(p_user uuid, p_kind text)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_handler_remove(p_user uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_handlers_list()` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_logist_candidates()` | org_role: лише власник / директор своєї організації | OK |
| `kp_repair_maintenance_list(p_from date, p_to date)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_post(p_vehicle uuid, p_date date, p_odometer integer, p_works text, p_provi)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_save_with_maintenance(p_repair uuid, p_vehicle uuid, p_date date, p_odometer integer, p_work)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_set_maintenance(p_repair uuid, p_type_ids uuid[])` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_update(p_repair uuid, p_date date, p_odometer integer, p_works text, p_provid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_vehicles()` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repair_void(p_repair uuid, p_reason text)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repairs_can_write()` | auth.uid() + org_role + права ремонтів | OK |
| `kp_repairs_context()` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repairs_list(p_from date, p_to date, p_vehicle uuid)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_repairs_org_id()` | auth.uid() + kp_org_id() | OK |
| `kp_repairs_role()` | kp_org_id() + kp_role() | OK |
| `kp_requisites_get()` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_requisites_save(p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_role()` | auth.uid() + org_role поточного користувача | OK |
| `kp_set_last_fuel_prices(p_fuel numeric, p_adblue numeric)` | auth.uid() + current_org_id() + org_role owner/logist + не заблокований; пише лише два ключі | OK |
| `kp_stock_adjust(p_part uuid, p_qty_delta numeric, p_unit_cost numeric, p_reason text)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_trailer_save(p_trailer uuid, p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trailers_list()` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trip_sheet_cancel(p_id uuid, p_reason text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_trip_sheet_close(p_id uuid, p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_trip_sheet_create(p_doc_date date, p_number integer, p_data jsonb, p_calculation uuid, p)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_trip_sheet_extra_save(p_id uuid, p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trip_sheet_get(p_id uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trip_sheet_list(p_from date, p_to date, p_status text, p_calculation uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trip_sheet_next_number(p_doc_date date)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trip_sheet_refuels_save(p_id uuid, p_rows jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trip_sheet_return_save(p_id uuid, p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_trips(p_from date, p_to date, p_only_unlinked boolean)` | kp_org_id() + kp_trip_visible(user_id) | OK |
| `kp_ttn_cancel(p_id uuid, p_reason text)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org; auth.uid() для автора / аудиту | OK |
| `kp_ttn_create(p_client uuid, p_doc_date date, p_number integer, p_data jsonb, p_calc)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_ttn_get(p_id uuid)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_ttn_list(p_from date, p_to date, p_client uuid, p_status text, p_calculation uu)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_ttn_next_number(p_doc_date date)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_ttn_prefill(p_calculation uuid, p_client uuid, p_vehicle uuid)` | kp_docs_org + kp_trip_visible(user_id): рейс бачить лише власник / директор, а логіст — свої (або всі, якщо власник дозволив); org_id = v_org | OK |
| `kp_vehicle_mileage(p_vehicle uuid, p_on date)` | kp_repairs_require_org / _write / _manage (роль власник / директор / логіст за правами ремонтів, активний учасник, Контроль+); усі запити з org_id = v_org | OK |
| `kp_vehicle_save(p_vehicle uuid, p_data jsonb)` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `kp_vehicles_list()` | kp_docs_org(read|write): активний учасник організації з Контроль+ і правом на документи (власник / директор / логіст за правами); вибірки й зміни лише з org_id = v_org | OK |
| `member_can(p_perm text)` | auth.uid() + org_role + перевірка дозволів учасника (service_role — повний) | OK |
| `member_require(p_perm text)` | member_can(p_perm): роль + права учасника, auth.uid() | OK |
| `org_logists_see_all()` | current_org_id() | OK |
| `report_plan_fact(p_from date, p_to date, p_group text)` | kp_org_id() + kp_trip_visible(user_id): звіт власника / директора; логіст лише свої рейси | OK |
| `touch_route_template(p_id uuid)` | is_user_blocked() + current_org_id(); UPDATE лише шаблонів своєї організації (company або власні) | OK |

## Таблиці з RLS без політик (14)

У Postgres RLS без політик = доступ заборонено всім, крім ролей з BYPASSRLS (`service_role`, власник таблиці — тому SECURITY DEFINER-функції працюють). Додатково в усіх цих таблиць **немає жодного гранту** `SELECT / INSERT / UPDATE / DELETE` для `authenticated` та `anon` (перевірено `has_table_privilege`), тож це подвійне замикання.

| таблиця | хто має доступ | висновок |
|---|---|---|
| `kp_doc_counters` | лічильники номерів: лише через kp_doc_next_number / kp_*_create (definer) | OK (deny-all для клієнтів) |
| `kp_doc_trip_sheet` | подорожні листи: kp_trip_sheet_* (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_doc_ttn` | ТТН: kp_ttn_* (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_doc_ttn_lines` | рядки ТТН: kp_ttn_* (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_document_lines` | рядки рахунків / актів: kp_doc_* (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_document_payments` | оплати документів: kp_payment_add / kp_payment_void (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_document_signatures` | підписи: kp_doc_sign / kp_doc_signed (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_documents` | рахунки / акти / договори: kp_doc_* (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_drivers` | довідник водіїв: kp_driver_* (kp_docs_org) | OK (deny-all для клієнтів) |
| `kp_org_requisites` | реквізити компанії: kp_requisites_get / kp_requisites_save (kp_docs_org) | OK (deny-all для клієнтів) |
| `payment_events` | події платежів: лише service_role (вебхуки, api/billing) | OK (deny-all для клієнтів) |
| `poi_cache` | кеш POI: лише service_role (api/poi.js) | OK (deny-all для клієнтів) |
| `regular_removals` | REMOVE регулярних платежів WayForPay: лише service_role (api/billing) | OK (deny-all для клієнтів) |
| `repair_invite_sends` | журнал розсилок запрошень ремонтів: лише service_role (api/team.js) | OK (deny-all для клієнтів) |
| `trailer_presets` | політика `trailer_presets_all` є, але RLS у репозиторії ніде не вмикався (таблиця створена поза міграціями) | | **дірка** → `ENABLE ROW LEVEL SECURITY` у `20261110091000_security_audit_fixes.sql` (на проді, якщо вже ввімкнено, нічого не змінюється) |
| `api_rate_limits` (нова) | лише service_role через `api_rate_hit` | OK (RLS без політик, гранти лише service_role) |

## Як повторити

`AUDIT_OUT=… node` на копії `apps/kontrol-plus/db/check-db.mjs` із запитами з розділу «Підсумок» перед підсумковим `if (failed)`; або на проді в SQL-редакторі:

```sql
SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1;
```
