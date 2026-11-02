-- Apply manually after review. This file is not applied to production by the agent.
-- Аудит SECURITY DEFINER-функцій і таблиць (docs/SECURITY-AUDIT-FUNCTIONS.md). Знайдені діри:
--   1. bump_calc_usage(p_org, p_limit): міграція 20261008 забирала EXECUTE лише у PUBLIC, а Supabase видає EXECUTE ролям anon /
--      authenticated окремо (default privileges). Функція приймає ЧУЖИЙ p_org, тож будь-хто, навіть без входу, міг накрутити
--      денний лічильник демо-розрахунків будь-якої компанії до ліміту (відмова в обслуговуванні) або зіпсувати usage_counters.
--      Функцію викликає лише сервер (api/calculate.js, service_role) → залишаємо тільки service_role.
--   2. trailer_presets: політика trailer_presets_all є (20261013080000), але RLS у репозиторії ніде не вмикається (таблиця
--      створена поза міграціями). Вмикаємо RLS — якщо вже ввімкнено на проді, нічого не змінюється.
-- Решта функцій: перевірено, діри немає (таблиця в docs/SECURITY-AUDIT-FUNCTIONS.md).
--
-- РУЧНИЙ ВІДКАТ (відновлює стару, небезпечну поведінку — не рекомендується):
--   GRANT EXECUTE ON FUNCTION public.bump_calc_usage(uuid, integer) TO anon, authenticated;
--   ALTER TABLE public.trailer_presets DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION public.bump_calc_usage(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_calc_usage(uuid, integer) TO service_role;

DO $$
BEGIN
  IF to_regclass('public.trailer_presets') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.trailer_presets ENABLE ROW LEVEL SECURITY';
  END IF;
END;
$$;
