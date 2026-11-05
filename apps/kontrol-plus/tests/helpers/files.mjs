// Файли теки (рекурсивно) як відносні шляхи від кореня застосунку: src/views має підтеки (напр. views/own-fleet/).
import fs from 'node:fs';
import path from 'node:path';

export function listFiles(appDir, rel) {
    const out = [];
    for (const entry of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
        const next = rel.replace(/\/$/, '') + '/' + entry.name;
        if (entry.isDirectory()) out.push(...listFiles(appDir, next));
        else out.push(next);
    }
    return out;
}
