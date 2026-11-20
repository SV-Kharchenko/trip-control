-- Apply manually after review. This file is not applied to any database by the agent.
-- Кабінет суперадміна, вкладка «Активність»: хто із зареєстрованих користувачів реально працює.
-- * public.sa_list_user_activity(p_days) — лише читання (SECURITY DEFINER, перша перевірка is_platform_superadmin(), як в інших sa_*).
-- * Вхід — auth.users.last_sign_in_at; дія — розрахунки (calculations.user_id). last_calc_at = max(greatest(created_at, updated_at)):
--   updated_at береться через to_jsonb(c), тож функція створюється й працює і там, де в calculations такої колонки немає (тоді враховується created_at).
-- * p_days (за замовчуванням 30, 1…365) — вікно другого лічильника (колонка calcs_30d); calcs_7d завжди 7 днів.
-- * Жодних UPDATE / DELETE. Ідемпотентно (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.sa_list_user_activity(p_days integer DEFAULT 30)
RETURNS TABLE (
  user_id uuid, email text, org_id uuid, org_name text, org_plan text, org_role text, member_status text,
  registered_at timestamptz, email_confirmed_at timestamptz, last_sign_in_at timestamptz,
  calcs_total integer, calcs_7d integer, calcs_30d integer, last_calc_at timestamptz, last_activity_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
BEGIN
  IF NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'SUPERADMIN_REQUIRED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH calc AS (
    SELECT c.user_id AS uid,
           count(*)::integer AS total,
           (count(*) FILTER (WHERE c.created_at >= now() - interval '7 days'))::integer AS d7,
           (count(*) FILTER (WHERE c.created_at >= now() - make_interval(days => v_days)))::integer AS dn,
           max(greatest(c.created_at, nullif(to_jsonb(c) ->> 'updated_at', '')::timestamptz)) AS last_at
    FROM public.calculations AS c
    WHERE c.user_id IS NOT NULL
    GROUP BY c.user_id
  )
  SELECT u.id, u.email::text, p.org_id, o.name, o.plan, p.org_role, p.member_status,
         u.created_at, u.email_confirmed_at, u.last_sign_in_at,
         coalesce(k.total, 0), coalesce(k.d7, 0), coalesce(k.dn, 0), k.last_at,
         greatest(u.last_sign_in_at, k.last_at)
  FROM auth.users AS u
  LEFT JOIN public.profiles AS p ON p.id = u.id
  LEFT JOIN public.organizations AS o ON o.id = p.org_id
  LEFT JOIN calc AS k ON k.uid = u.id
  ORDER BY greatest(u.last_sign_in_at, k.last_at) DESC NULLS LAST, u.created_at DESC, u.id;
END;
$$;

REVOKE ALL ON FUNCTION public.sa_list_user_activity(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sa_list_user_activity(integer) TO authenticated;
