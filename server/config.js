import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: parseInt(env('PORT', '8080'), 10),
  pollMs: parseInt(env('POLL_MS', '3000'), 10),

  // Proxmox VE
  pveHost: env('PVE_HOST', '192.168.20.2'),
  pvePort: parseInt(env('PVE_PORT', '8006'), 10),
  pveNode: env('PVE_NODE', 'pve'),
  pveTokenId: env('PVE_TOKEN_ID', ''),
  pveTokenSecret: env('PVE_TOKEN_SECRET', ''),

  // Data sources
  promUrl: env('PROM_URL', 'http://192.168.20.50:9090'),
  lokiUrl: env('LOKI_URL', 'http://192.168.20.50:3100'),
  grafanaUrl: env('GRAFANA_URL', 'http://192.168.20.50:3000'),

  // Loki label used to select a host's logs, e.g. {host="pve"}
  lokiLabel: env('LOKI_LABEL', 'host'),
};

// External (non-Proxmox) cards — NAS, router — driven by Prometheus queries.
// The metric names here are environment specific; adjust config/cards.json.
let externalCards = [];
try {
  externalCards = JSON.parse(
    readFileSync(join(__dirname, '..', 'config', 'cards.json'), 'utf8')
  );
} catch (e) {
  console.warn('[config] config/cards.json not loaded:', e.message);
}
export { externalCards };

export const pveBase = `https://${config.pveHost}:${config.pvePort}/api2/json`;
export const pveAuthHeader = `PVEAPIToken=${config.pveTokenId}=${config.pveTokenSecret}`;
