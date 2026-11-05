// GET /api/config — публічна конфігурація фронтенду (адреса бази, anon-ключ, середовище, вимкнені модулі) з env Vercel.
// Статичний файл: реальний файл у api/ має пріоритет над rewrite /api/:path* → trip-control.com; потрібен preview-деплоям «Контроль+».
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (публічний ключ!), необовʼязково KP_DISABLED_FEATURES, APP_ENV. Service role сюди не потрапляє.
import { createConfigHandler } from '../lib/public-config.js';

export default createConfigHandler();
