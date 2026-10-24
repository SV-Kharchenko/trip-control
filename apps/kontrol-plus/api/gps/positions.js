// POST /api/gps/positions — карта (етап 2c). Статичний файл: реальний файл у api/ має пріоритет над rewrite
// /api/:path* → trip-control.com. Логіка — lib/gps/api.js.
import { gpsVercelRoute } from '../../lib/gps/vercel.js';

export default gpsVercelRoute('positions');
