import { createClient } from '@supabase/supabase-js';
import { createTelegramWebhookHandler } from '../lib/telegram-admin.js';

/**
 * POST /api/telegram-webhook — апдейти Telegram-бота власника.
 * Заголовок X-Telegram-Bot-Api-Secret-Token має дорівнювати TELEGRAM_WEBHOOK_SECRET, інакше 401.
 * Обробляє лише чат TELEGRAM_CHAT_ID: кнопки статусу (st:<status>:<user_id>) і /user <email>.
 * Вебхук реєструє scripts/set-telegram-webhook.js.
 */
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default createTelegramWebhookHandler({ supabase, fetch: (...args) => fetch(...args), env: process.env });
