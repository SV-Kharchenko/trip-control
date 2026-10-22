import { defineConfig } from 'vite';

// Ключі Supabase приходять лише з env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY) — у репозиторії їх немає.
export default defineConfig({
    envPrefix: 'VITE_',
    build: {
        target: 'es2020',
        sourcemap: false,
    },
    server: { port: 5174 },
    preview: { port: 4174 },
});
