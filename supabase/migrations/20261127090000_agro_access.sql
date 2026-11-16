-- Apply manually after review. This file is not applied to production by the agent.
--
-- Доступ до AGRO (agro.trip-control.com) з Контроль+: кнопка «АГРО» у шапці КП видає разовий підписаний токен (apps/kontrol-plus/api/agro/sso.js),
-- а ця міграція вирішує, кому це дозволено. AGRO — окремий репозиторій і окрема база; тут лише прапорці доступу на боці trip-control.
--
-- * Глобальний вимикач — рядок app_settings('agro'), за замовчуванням вимкнений. Прапорець компанії — organizations.features.agro (наявна
--   sa_set_org_feature; нічого в ній не змінюємо — ключ agro тепер «відомий модуль», бо є рядок app_settings).
-- * agro_user_access(user_id, allowed): персональне перевизначення «дозволено / заборонено» поверх компанії. Немає рядка — успадковує компанію.
--   Таблиця закрита від anon / authenticated (RLS без політик, REVOKE), пише лише sa_set_user_agro, читає лише service_role.
-- * agro_access_for(user) → {allowed, reason}: порядок global_off → user_blocked / email_unconfirmed → no_org → org_blocked → user_override → org.
--   Тариф не перевіряється. Лише service_role (його викликає api/agro/sso.js із JWT користувача, перевіреним auth.getUser).
-- * agro_access_me() → boolean для кнопки в шапці: лише підказка, справжня перевірка — на сервері при видачі токена.
-- * sa_set_user_agro / sa_list_org_agro_users — для кабінету суперадміна (#/superadmin); першим рядком is_platform_superadmin() (інакше 42501).
--
-- Лише адитивно: нова таблиця, нові функції, рядок-засів вимкненого модуля. Ідемпотентно.
-- РУЧНИЙ ВІДКАТ: DROP FUNCTION public.sa_list_org_agro_users(uuid), public.sa_set_user_agro(uuid, boolean), public.agro_access_me(),
--   public.agro_access_for(uuid); DROP TABLE public.agro_user_access; DELETE FROM public.app_settings WHERE key = 'agro'.

INSERT INTO public.app_settings (key, enabled) VALUES ('agro', false) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.agro_user_access (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  allowed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL
);

ALTER TABLE public.agro_user_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agro_user_access FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.agro_user_access TO service_role;

-- plpgsql (а не sql): тіло перевіряється під час виклику, тож колонки auth.users не потрібні в момент створення функції.
CREATE OR REPLACE FUNCTION public.agro_access_for(p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_banned timestamptz;
  v_confirmed timestamptz;
  v_org uuid;
  v_status text;
  v_override boolean;
BEGIN
  IF NOT public.feature_enabled('agro') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'global_off');
  END IF;
  SELECT u.banned_until, u.email_confirmed_at INTO v_banned, v_confirmed FROM auth.users AS u WHERE u.id = p_user;
  IF NOT FOUND OR (v_banned IS NOT NULL AND v_banned > now()) THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'user_blocked');
  END IF;
  IF v_confirmed IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'email_unconfirmed');
  END IF;
  SELECT p.org_id INTO v_org FROM public.profiles AS p WHERE p.id = p_user AND p.member_status = 'active';
  IF v_org IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_org');
  END IF;
  SELECT o.status INTO v_status FROM public.organizations AS o WHERE o.id = v_org;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_org');
  END IF;
  IF v_status = 'blocked' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'org_blocked');
  END IF;
  SELECT a.allowed INTO v_override FROM public.agro_user_access AS a WHERE a.user_id = p_user;
  IF FOUND THEN
    RETURN jsonb_build_object('allowed', v_override, 'reason', 'user_override');
  END IF;
  RETURN jsonb_build_object('allowed', public.org_has_feature(v_org, 'agro'), 'reason', 'org');
END;
$$;

REVOKE ALL ON FUNCTION public.agro_access_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agro_access_for(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.agro_access_me()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((public.agro_access_for(auth.uid()) ->> 'allowed')::boolean, false);
$$;

REVOKE ALL ON FUNCTION public.agro_access_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agro_access_me() TO authenticated, service_role;

-- null = прибрати перевизначення (користувач знову успадковує компанію).
CREATE OR REPLACE FUNCTION public.sa_set_user_agro(p_user uuid, p_allowed boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old boolean;
  v_had boolean;
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p_user) THEN
    RAISE EXCEPTION 'SA_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT a.allowed INTO v_old FROM public.agro_user_access AS a WHERE a.user_id = p_user FOR UPDATE;
  v_had := FOUND;
  IF p_allowed IS NULL THEN
    DELETE FROM public.agro_user_access WHERE user_id = p_user;
  ELSE
    INSERT INTO public.agro_user_access (user_id, allowed, updated_at, updated_by)
    VALUES (p_user, p_allowed, now(), auth.uid())
    ON CONFLICT (user_id) DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now(), updated_by = auth.uid();
  END IF;
  IF v_old IS DISTINCT FROM p_allowed OR (v_had AND p_allowed IS NULL) THEN
    PERFORM public.sa_audit('user.agro.set', 'user', p_user::text,
      jsonb_build_object('allowed', CASE WHEN v_had THEN to_jsonb(v_old) ELSE NULL END), jsonb_build_object('allowed', to_jsonb(p_allowed)));
  END IF;
  RETURN jsonb_build_object('user_id', p_user, 'override', p_allowed);
END;
$$;

CREATE OR REPLACE FUNCTION public.sa_list_org_agro_users(p_org uuid)
RETURNS TABLE (user_id uuid, email text, org_role text, override boolean, allowed boolean, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'SA_ORG_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- agro_access_for рахуємо один раз на рядок (LATERAL), а не двічі для allowed і reason.
  RETURN QUERY
  SELECT p.id, u.email::text, p.org_role::text, a.allowed, (x.acc ->> 'allowed')::boolean, (x.acc ->> 'reason')::text
  FROM public.profiles AS p
  JOIN auth.users AS u ON u.id = p.id
  LEFT JOIN public.agro_user_access AS a ON a.user_id = p.id
  CROSS JOIN LATERAL (SELECT public.agro_access_for(p.id) AS acc) AS x
  WHERE p.org_id = p_org AND p.member_status = 'active'
  ORDER BY lower(coalesce(u.email::text, '')), p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.sa_set_user_agro(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sa_list_org_agro_users(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_set_user_agro(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sa_list_org_agro_users(uuid) TO authenticated;
