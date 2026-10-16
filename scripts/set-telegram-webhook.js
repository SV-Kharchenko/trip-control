// Реєструє вебхук бота: https://<домен>/api/telegram-webhook із secret_token.
// Запускає власник вручну, один раз після deploy:
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
//   node scripts/set-telegram-webhook.js https://<домен>
//
// Секрет: 1–256 символів A-Z a-z 0-9 _ -. Той самий має бути у Vercel env TELEGRAM_WEBHOOK_SECRET.

const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!/^https:\/\/[^/\s]+$/.test(base)) {
    console.error('Вкажіть домен: node scripts/set-telegram-webhook.js https://<домен>');
    process.exit(1);
}
if (!token || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    console.error('Потрібні TELEGRAM_BOT_TOKEN і TELEGRAM_WEBHOOK_SECRET (A-Z a-z 0-9 _ -, до 256 символів).');
    process.exit(1);
}

const response = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        url: base + '/api/telegram-webhook',
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true
    })
});
const result = await response.json().catch(() => ({}));
if (!response.ok || !result.ok) {
    console.error('setWebhook не вдався:', response.status, result.description || '');
    process.exit(1);
}
console.log('Вебхук встановлено:', base + '/api/telegram-webhook');
