// GET /api/config — публічна конфігурація фронтенду (адреса бази, anon-ключ, середовище, вимкнені модулі) з env Vercel.
// index.html підключає її блокувальним <script src="/api/config"> перед ініціалізацією Supabase. Логіка й правила — lib/public-config.js.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (публічний ключ!), необовʼязково KP_DISABLED_FEATURES, APP_ENV. Service role сюди не потрапляє.
import { createConfigHandler } from '../lib/public-config.js';

export default createConfigHandler();
