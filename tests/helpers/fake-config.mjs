// Спільна підміна /api/config для stub-серверів тестів: справжнього ключа й prod-адреси тут немає.
export const FAKE_CONFIG_JS = "window.TC_CONFIG = Object.freeze({supabaseUrl:'https://example.supabase.co', supabaseAnonKey:'sb_publishable_TestOnly_not_a_real_key', env:'production', disabledFeatures:[]});";

export function handleFakeConfig(req, res) {
    if (new URL(req.url, 'http://x').pathname !== '/api/config') return false;
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(FAKE_CONFIG_JS);
    return true;
}
