-- Apply manually after review. This file is not applied to production by the agent.
--
-- Тріал 7 днів для НОВИХ компаній (сайт і Контроль+).
--
-- ЯК УСТРОЄНО ЗАРАЗ (знайдено, нових сутностей зайвих немає): тариф — public.org_subscriptions (org_id, paid_until, reminder_sent_for…),
-- платежі — payments, зарахування — apply_payment_success. Повний доступ = profiles.is_approved (ручний, постійний) АБО paid_until > now()
-- (org_has_paid_access → current_is_approved()). Без цього компанія в «Демо» (ліміти: збережені розрахунки, шаблони, лічильник
-- /api/calculate). Тарифи company | control_plus — organizations.plan (set_org_plan), на оплату не впливає. Нова компанія створюється тригером
-- on_auth_user_created_tripcontrol → handle_new_tripcontrol_user() (organizations + profiles(owner) + org_company_profiles).
--
-- ЩО ДОДАНО:
--  * org_subscriptions.trial_ends_at / trial_notified_d5 / trial_notified_d7. trial_ends_at = початок київської доби (дата реєстрації + 7 днів),
--    тобто тріал триває до кінця 7-го дня, день реєстрації — 1-й. NULL = тріалу немає (усі наявні компанії; міграція їх НЕ чіпає).
--  * trial_claims — один тріал на email та на ЄДРПОУ/ІПН (клієнтам закрита). Рядок прив'язаний до компанії (ON DELETE CASCADE): тимчасова
--    компанія запрошеного логіста, яку видаляє accept_org_invite, тріал не «спалює». Існуючі email і ЄДРПОУ записано як зайняті.
--  * Тригер trg_trial_start на profiles: перший owner нової компанії бере email-claim; вільний — отримує trial_ends_at, інакше тріалу немає
--    (звичайне демо, як було). Тригер на org_company_profiles.edrpou: ЄДРПОУ/ІПН (8 або 10 цифр), уже зайнятий іншою компанією,
--    скасовує ще не оплачений тріал цієї компанії (trial_ends_at = NULL).
--  * Під час тріалу current_is_approved() = true (повний доступ без демо-лімітів).
--  * Після тріалу без оплати (і без is_approved) org_readonly(org) = true: тригер trg_trial_readonly на calculations, kp_documents,
--    kp_document_lines, kp_contracts, kp_doc_ttn, kp_other_docs блокує INSERT і UPDATE (42501 TRIAL_EXPIRED). SELECT, експорт CSV, DELETE-політики
--    не змінено; нічого не видаляється. Оплата (paid_until > now()) знімає блок одразу. Запити service_role (сервер) тригер пропускає:
--    сервер перевіряє те саме в api/calculate.js та api/team.js (lib/billing/access.js, isOrgReadOnly).
--  * org_notifications.kind: + trial_day5, trial_day7 (надсилає /api/billing/cron, позначки trial_notified_d5 / _d7 проти дублів).
--
-- РУЧНИЙ ВІДКАТ (SQL editor, однією транзакцією; дані trial_* буде втрачено):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_trial_readonly ON public.calculations;
--   DROP TRIGGER IF EXISTS trg_trial_readonly ON public.kp_documents;
--   DROP TRIGGER IF EXISTS trg_trial_readonly ON public.kp_document_lines;
--   DROP TRIGGER IF EXISTS trg_trial_readonly ON public.kp_contracts;
--   DROP TRIGGER IF EXISTS trg_trial_readonly ON public.kp_doc_ttn;
--   DROP TRIGGER IF EXISTS trg_trial_readonly ON public.kp_other_docs;
--   DROP TRIGGER IF EXISTS trg_trial_start ON public.profiles;
--   DROP TRIGGER IF EXISTS trg_trial_tax_claim ON public.org_company_profiles;
--   DROP FUNCTION IF EXISTS public.trial_readonly_guard();
--   DROP FUNCTION IF EXISTS public.trial_start_guard();
--   DROP FUNCTION IF EXISTS public.trial_tax_claim_guard();
--   -- Оригінальне тіло current_is_approved(): CREATE OR REPLACE із 20261018190000_payments.sql (без org_trial_active).
--   CREATE OR REPLACE FUNCTION public.current_is_approved() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
--     SELECT coalesce((SELECT p.is_approved OR coalesce(public.org_has_paid_access(public.current_org_id()), false)
--                      FROM public.profiles AS p WHERE p.id = auth.uid() LIMIT 1), false);
--   $f$;
--   -- Оригінальне тіло org_has_user_data(): CREATE OR REPLACE із 20261018190000_payments.sql (рядок org_subscriptions рахується даними).
--   DROP FUNCTION IF EXISTS public.org_readonly(uuid);
--   DROP FUNCTION IF EXISTS public.org_trial_active(uuid);
--   DROP FUNCTION IF EXISTS public.trial_end_for(timestamptz);
--   DROP FUNCTION IF EXISTS public.trial_norm_email(text);
--   DELETE FROM public.org_notifications WHERE kind IN ('trial_day5', 'trial_day7');
--   ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_kind_check;
--   ALTER TABLE public.org_notifications ADD CONSTRAINT org_notifications_kind_check
--     CHECK (kind IN ('approval_pending', 'signature_used', 'doc_emailed', 'approval_decided'));
--   DROP TABLE IF EXISTS public.trial_claims;
--   ALTER TABLE public.org_subscriptions DROP COLUMN IF EXISTS trial_notified_d7, DROP COLUMN IF EXISTS trial_notified_d5, DROP COLUMN IF EXISTS trial_ends_at;
--   COMMIT;

BEGIN;

ALTER TABLE public.org_subscriptions
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_notified_d5 timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_notified_d7 timestamptz NULL;

-- Один тріал на email та на ЄДРПОУ/ІПН. Закрита від клієнтів (RLS без політик).
CREATE TABLE IF NOT EXISTS public.trial_claims (
  kind text NOT NULL CHECK (kind IN ('email', 'tax')),
  key text NOT NULL CHECK (length(key) BETWEEN 3 AND 320),
  org_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS trial_claims_org_idx ON public.trial_claims (org_id);
ALTER TABLE public.trial_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trial_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.trial_claims TO service_role;

-- ---------------------------------------------------------------------------
-- Хелпери
-- ---------------------------------------------------------------------------

-- Email без регістру; без +тегу; для gmail ще без крапок у локальній частині.
CREATE OR REPLACE FUNCTION public.trial_norm_email(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p IS NULL OR position('@' IN p) < 2 THEN NULL
    ELSE (CASE WHEN split_part(p, '@', 2) IN ('gmail.com', 'googlemail.com')
               THEN replace(split_part(split_part(p, '@', 1), '+', 1), '.', '')
               ELSE split_part(split_part(p, '@', 1), '+', 1) END)
         || '@' || (CASE WHEN split_part(p, '@', 2) = 'googlemail.com' THEN 'gmail.com' ELSE split_part(p, '@', 2) END)
  END
  FROM (SELECT lower(trim(p_email)) AS p) AS x;
$$;

-- Кінець тріалу: початок київської доби (дата реєстрації + 7 днів) = кінець 7-го дня, день реєстрації — 1-й.
CREATE OR REPLACE FUNCTION public.trial_end_for(p_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (date_trunc('day', p_at AT TIME ZONE 'Europe/Kyiv') + interval '7 days') AT TIME ZONE 'Europe/Kyiv';
$$;

CREATE OR REPLACE FUNCTION public.org_trial_active(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_subscriptions AS s
    WHERE s.org_id = p_org AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at > now()
  );
$$;

-- «Лише читання»: тріал був і скінчився, оплати немає, ручного повного доступу (is_approved) немає.
CREATE OR REPLACE FUNCTION public.org_readonly(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.org_subscriptions AS s
           WHERE s.org_id = p_org AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= now()
             AND (s.paid_until IS NULL OR s.paid_until <= now())
         )
     AND NOT EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.org_id = p_org AND p.is_approved);
$$;

REVOKE ALL ON FUNCTION public.trial_norm_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_end_for(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.org_trial_active(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.org_readonly(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trial_norm_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trial_end_for(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.org_trial_active(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.org_readonly(uuid) TO service_role;

-- Повний доступ: ручне схвалення, оплачена компанія або активний тріал (як у 20261018190000_payments.sql + org_trial_active).
CREATE OR REPLACE FUNCTION public.current_is_approved()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT p.is_approved
           OR coalesce(public.org_has_paid_access(public.current_org_id()), false)
           OR coalesce(public.org_trial_active(public.current_org_id()), false)
    FROM public.profiles AS p
    WHERE p.id = auth.uid()
    LIMIT 1
  ), false);
$$;

REVOKE ALL ON FUNCTION public.current_is_approved() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_is_approved() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Старт тріалу: перший owner нової компанії
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trial_start_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := public.trial_norm_email(NEW.email);
  v_rows integer;
BEGIN
  IF NEW.org_id IS NULL OR NEW.org_role IS DISTINCT FROM 'owner' OR v_key IS NULL THEN
    RETURN NEW;
  END IF;
  -- Лише свіжа компанія: один профіль і ще немає рядка підписки (наявні компанії тріалу не отримують).
  IF EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.org_id = NEW.org_id AND p.id <> NEW.id)
     OR EXISTS (SELECT 1 FROM public.org_subscriptions AS s WHERE s.org_id = NEW.org_id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.trial_claims (kind, key, org_id) VALUES ('email', v_key, NEW.org_id)
  ON CONFLICT (kind, key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    INSERT INTO public.org_subscriptions (org_id, trial_ends_at) VALUES (NEW.org_id, public.trial_end_for(now()))
    ON CONFLICT (org_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trial_start_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_trial_start ON public.profiles;
CREATE TRIGGER trg_trial_start
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trial_start_guard();

-- ЄДРПОУ / ІПН у профілі компанії: уже зайнятий іншою компанією — тріал цієї (ще не оплаченої) компанії скасовується.
CREATE OR REPLACE FUNCTION public.trial_tax_claim_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := regexp_replace(coalesce(NEW.edrpou, ''), '\D', '', 'g');
  v_rows integer;
BEGIN
  IF length(v_key) NOT IN (8, 10) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.trial_claims (kind, key, org_id) VALUES ('tax', v_key, NEW.org_id)
  ON CONFLICT (kind, key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 AND NOT EXISTS (SELECT 1 FROM public.trial_claims AS c WHERE c.kind = 'tax' AND c.key = v_key AND c.org_id = NEW.org_id) THEN
    UPDATE public.org_subscriptions
    SET trial_ends_at = NULL, updated_at = now()
    WHERE org_id = NEW.org_id AND trial_ends_at IS NOT NULL AND (paid_until IS NULL OR paid_until <= now());
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trial_tax_claim_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_trial_tax_claim ON public.org_company_profiles;
CREATE TRIGGER trg_trial_tax_claim
  AFTER INSERT OR UPDATE OF edrpou ON public.org_company_profiles
  FOR EACH ROW EXECUTE FUNCTION public.trial_tax_claim_guard();

-- Наявні email і ЄДРПОУ/ІПН вважаються зайнятими (повторна реєстрація з ними тріал не дає). Наявних компаній це не змінює.
INSERT INTO public.trial_claims (kind, key, org_id)
SELECT 'email', public.trial_norm_email(p.email), min(p.org_id::text)::uuid
FROM public.profiles AS p
WHERE p.org_id IS NOT NULL AND public.trial_norm_email(p.email) IS NOT NULL
GROUP BY public.trial_norm_email(p.email)
ON CONFLICT (kind, key) DO NOTHING;
INSERT INTO public.trial_claims (kind, key, org_id)
SELECT 'tax', regexp_replace(c.edrpou, '\D', '', 'g'), min(c.org_id::text)::uuid
FROM public.org_company_profiles AS c
WHERE length(regexp_replace(coalesce(c.edrpou, ''), '\D', '', 'g')) IN (8, 10)
GROUP BY regexp_replace(c.edrpou, '\D', '', 'g')
ON CONFLICT (kind, key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- «Лише читання» після тріалу: нові й змінені розрахунки, заявки, документи
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trial_readonly_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  -- Сервер (service_role) і системні операції без користувача пропускаємо; сервер перевіряє сам (isOrgReadOnly).
  IF coalesce(auth.jwt() ->> 'role', '') = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  v_org := coalesce(NEW.org_id, public.current_org_id());
  IF v_org IS NOT NULL AND public.org_readonly(v_org) THEN
    RAISE EXCEPTION 'TRIAL_EXPIRED' USING ERRCODE = '42501',
      DETAIL = 'Тріал закінчився: акаунт у режимі «лише читання». Оплатіть тариф, щоб створювати розрахунки й документи.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trial_readonly_guard() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['calculations', 'kp_documents', 'kp_document_lines', 'kp_contracts', 'kp_doc_ttn', 'kp_other_docs'] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_trial_readonly ON public.%I', v_table);
      EXECUTE format('CREATE TRIGGER trg_trial_readonly BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.trial_readonly_guard()', v_table);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- org_has_user_data: рядок org_subscriptions лише з тріалом — це не дані користувача (інакше тимчасова компанія запрошеного
-- логіста не видалялась би в accept_org_invite). Решта — без змін щодо 20261018190000_payments.sql; оплачена компанія зберігається.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.org_has_user_data(p_org_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table text;
  v_found boolean;
  v_settings jsonb;
  -- Current STARTER_SETTINGS in index.html (same values).
  v_starter_current constant jsonb := jsonb_build_object(
    'totalFleet', 1, 'fuelLoad', 38, 'fuelEmpty', 32, 'fuelPrice', 95,
    'adblueEnable', 'on', 'adblueConsumption', 2.85, 'adbluePrice', 18,
    'driverPayMode', 'km', 'driverRateLoad', 4.03, 'driverRateEmpty', 2.3,
    'driverPctVal', 12, 'perDiem', 500, 'toCost', 18000, 'toPeriod', 50000,
    'tireCost', 16500, 'tireCount', 14, 'tireMileage', 150000
  );
BEGIN
  IF p_org_id IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles AS p
    WHERE p.org_id = p_org_id AND p.id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN true;
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'calculations', 'calc_vehicles', 'trip_actuals', 'route_templates',
    'fleet_vehicles', 'trailer_presets', 'weekly_reports',
    -- A company that paid is kept (payments outlive nothing silently). A bare trial row (no payment) is not user data.
    'payments'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns AS c
      WHERE c.table_schema = 'public' AND c.table_name = v_table AND c.column_name = 'org_id'
    ) THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE org_id = $1)', v_table)
        INTO v_found
        USING p_org_id;
      IF v_found THEN
        RETURN true;
      END IF;
    END IF;
  END LOOP;

  -- Signup writes {"logists_see_all": false}; the first sign-in autosaves the
  -- current starter template. Neither is user data.
  SELECT coalesce((
    SELECT jsonb_object_agg(e.key, e.value)
    FROM jsonb_each(coalesce(s.settings, '{}'::jsonb) - 'logists_see_all') AS e
    WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb)
  ), '{}'::jsonb)
  INTO v_settings
  FROM public.company_settings AS s
  WHERE s.org_id = p_org_id;

  IF v_settings IS NOT NULL
     AND NOT (v_starter_current @> v_settings)
  THEN
    RETURN true;
  END IF;

  -- Signup fills only ownership; EDRPOU, phone, address and the rest come from the cabinet.
  IF EXISTS (
    SELECT 1
    FROM public.org_company_profiles AS ocp,
         jsonb_each(to_jsonb(ocp) - ARRAY['org_id', 'ownership', 'lang', 'updated_at', 'updated_by', 'created_at']) AS f
    WHERE ocp.org_id = p_org_id
      AND f.value NOT IN ('null'::jsonb, '""'::jsonb)
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (SELECT 1 FROM public.org_subscriptions AS s WHERE s.org_id = p_org_id AND (s.paid_until IS NOT NULL OR s.last_plan IS NOT NULL)) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;


REVOKE ALL ON FUNCTION public.org_has_user_data(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_user_data(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Сповіщення тріалу (5-й і 7-й день)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_notifications DROP CONSTRAINT IF EXISTS org_notifications_kind_check;
ALTER TABLE public.org_notifications
  ADD CONSTRAINT org_notifications_kind_check
  CHECK (kind IN ('approval_pending', 'signature_used', 'doc_emailed', 'approval_decided', 'trial_day5', 'trial_day7'));

COMMIT;
