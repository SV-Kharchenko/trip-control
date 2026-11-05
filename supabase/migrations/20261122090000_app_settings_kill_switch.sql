-- Apply manually after review. This file is not applied to production by the agent.
--
-- Глобальний вимикач модулів. Один рядок app_settings на модуль: enabled = true вмикає модуль для всієї платформи, false (або відсутність рядка) —
-- вимикає для всіх, навіть для організацій із власним прапорцем.
--
-- * app_settings(key, enabled, updated_at): читати можуть authenticated, писати — лише service_role (SQL-редактор / API з service_role).
-- * feature_enabled(key): SECURITY DEFINER, STABLE. Немає рядка → false.
-- * org_has_feature(org, key) = feature_enabled(key) AND прапорець організації (organizations.features ->> key = 'true').
--   Функція може вже існувати з міграції модуля «Власний парк» (*_own_fleet.sql); тут вона переозначається, а колонка features додається
--   IF NOT EXISTS, тож міграція самодостатня й безпечна в будь-якому порядку застосування (її мітка пізніша за *_own_fleet*).
--   Наслідок: «Власний парк» вмикається двома ключами — глобальним (INSERT у app_settings) і прапорцем організації.
--
-- Лише адитивно: нова таблиця, нові функції, CREATE OR REPLACE org_has_feature (та сама сигнатура й гранти). Ідемпотентно.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 64 AND key ~ '^[a-z][a-z0-9_]*$'),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;

DROP POLICY IF EXISTS app_settings_select ON public.app_settings;
CREATE POLICY app_settings_select ON public.app_settings FOR SELECT TO authenticated USING (true);
-- Політик на INSERT / UPDATE / DELETE немає (і грантів теж): писати може лише service_role, який обходить RLS.

CREATE OR REPLACE FUNCTION public.app_settings_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_settings_touch ON public.app_settings;
CREATE TRIGGER trg_app_settings_touch BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_settings_touch();

CREATE OR REPLACE FUNCTION public.feature_enabled(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((SELECT s.enabled FROM public.app_settings AS s WHERE s.key = p_key), false);
$$;

REVOKE ALL ON FUNCTION public.feature_enabled(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_enabled(text) TO authenticated, service_role;

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.org_has_feature(p_org uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.feature_enabled(p_key)
         AND coalesce((SELECT o.features ->> p_key = 'true' FROM public.organizations AS o WHERE o.id = p_org), false);
$$;

REVOKE ALL ON FUNCTION public.org_has_feature(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_has_feature(uuid, text) TO service_role;
