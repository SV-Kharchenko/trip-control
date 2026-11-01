// CSP-рядки vercel.json; шлях `support` (PR store-pwa) прибираємо, щоб порівнювати з origin/main лише самі політики.
export const withoutSupport = (source) => source.replace('support$|', '').replace('|support', '');
export const cspLines = (cfg) => cfg.headers.flatMap((b) => b.headers
    .filter((x) => x.key === 'Content-Security-Policy').map((x) => withoutSupport(b.source) + ' => ' + x.value));
