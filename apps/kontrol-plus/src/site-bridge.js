// Точка входу, яку збірка інжектить у копію index.html сайту (scripts/site-html.mjs). Логіка — у bridge.js.
import './crm.css';
import './cabinet-slot.css';
import './kp-shell.css';
import './kp-registry.css';
import './kp-windows.css';
import './kp-calc.css';
import './kp-dashboard.css';
import { startBridge } from './bridge.js';
import { watchCalcMap } from './kp-calc.js';

startBridge();
watchCalcMap();
