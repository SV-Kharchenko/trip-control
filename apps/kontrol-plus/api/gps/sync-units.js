// POST /api/gps/sync-units — статичний файл (не динамічний [param]): реальний файл у api/ гарантовано має пріоритет над
// rewrite /api/:path* → trip-control.com. Логіка — lib/gps/api.js, спільна для всіх чотирьох маршрутів.
import { gpsVercelRoute } from '../../lib/gps/vercel.js';

export default gpsVercelRoute('sync-units');
