// Точка входу, яку збірка інжектить у копію index.html сайту (scripts/site-html.mjs). Логіка — у bridge.js.
import './crm.css';
import './cabinet-slot.css';
import './kp-shell.css';
import './kp-registry.css';
import { startBridge } from './bridge.js';

startBridge();
