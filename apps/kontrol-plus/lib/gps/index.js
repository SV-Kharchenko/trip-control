// Реєстр GPS-провайдерів. Інтерфейс провайдера:
//   validateCredentials({ apiHost, hostKind, token }) → { ok, account, unitsTotal } | { ok: false, code }
//   listUnits(creds) → [{ externalId, name }]
//   fetchPositions(creds, externalIds?) → [{ externalId, t, lat, lon, speed, course, sats, altitude }]
// Новий провайдер = новий файл у providers/ + рядок тут + розширення CHECK provider в окремій міграції.
import { createWialonProvider } from './providers/wialon.js';

const FACTORIES = { wialon: createWialonProvider };

export const PROVIDER_IDS = Object.keys(FACTORIES);

export function getProvider(id, deps) {
    const factory = Object.prototype.hasOwnProperty.call(FACTORIES, id) ? FACTORIES[id] : null;
    if (!factory) throw new Error('Unknown GPS provider');
    return factory(deps);
}
