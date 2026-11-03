import fs from 'node:fs';
const edit = (f, pairs) => { let t = fs.readFileSync(f, 'utf8'); for (const [x, y] of pairs) { if (t.split(x).length !== 2) throw new Error(f + ': ' + x.slice(0, 60)); t = t.replace(x, () => y); } fs.writeFileSync(f, t); };
edit('index.html', [[`        if (f.client && isKP() && REGISTRY_UUID.test(f.client)) out.client = f.client;
        return out;`, `        if (f.client && isKP() && REGISTRY_UUID.test(f.client)) out.client = f.client;
        // Директор Контроль+: компанія з kp_context() (активна організація Контроль+), не профільна current_org_id().
        if (kpDirectorActive() && typeof window.tcKpOrgId === 'string' && REGISTRY_UUID.test(window.tcKpOrgId)) out.org_id = window.tcKpOrgId;
        return out;`]]);
edit('apps/kontrol-plus/src/bridge.js', [[`    window.tcKpRole = state.context.role || null;`, `    window.tcKpRole = state.context.role || null;
    window.tcKpOrgId = state.context.org_id || null;`]]);
