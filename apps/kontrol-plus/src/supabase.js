import { createClient } from '@supabase/supabase-js';

// Ті самі публічні URL і anon key, що й на trip-control.com, — лише з env збірки (Vercel / .env.local).
// Права визначає сервер (RLS і функції БД), тож anon key у бандлі — нормальна річ, а service key сюди не потрапляє ніколи.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const SITE_URL = (import.meta.env.VITE_SITE_URL || 'https://trip-control.com').replace(/\/+$/, '');
export const configured = Boolean(url && anonKey);

export const supabase = configured
    ? createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'kp-auth' },
    })
    : null;
