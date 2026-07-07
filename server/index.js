import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config, externalCards } from './config.js';
import { pve, promInstant, lokiRange } from './upstream.js';
import { demoGrid, demoRrd, demoLogs } from './demo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// --- Public (non-secret) config for the frontend -------------------------
app.get('/api/config', (req, res) => {
  res.json({
    pollMs: config.pollMs,
    node: config.pveNode,
    grafanaEnabled: Boolean(config.grafanaUrl),
  });
});

// --- Grid: one aggregated call the frontend polls every POLL_MS ----------
// Returns cards already ordered: host, guests (by vmid), then external.
app.get('/api/grid', async (req, res) => {
  if (config.demo) {
    res.set('Cache-Control', 'no-store');
    return res.json(demoGrid());
  }
  const cards = [];

  // 1) Host card
  try {
    const s = await pve(`/nodes/${config.pveNode}/status`);
    cards.push({
      id: `node/${config.pveNode}`,
      kind: 'host',
      name: config.pveNode,
      status: 'running',
      cpu: s.cpu,
      cpuMax: s.cpuinfo?.cpus ?? 1,
      mem: s.memory?.used ?? null,
      memMax: s.memory?.total ?? null,
      uptime: s.uptime ?? null,
      load: Array.isArray(s.loadavg) ? s.loadavg.map(Number) : null,
    });
  } catch (e) {
    cards.push({
      id: `node/${config.pveNode}`, kind: 'host', name: config.pveNode,
      status: 'unknown', error: e.message,
    });
  }

  // 2) Guests (VM + LXC)
  try {
    const resources = await pve('/cluster/resources?type=vm');
    resources
      .sort((a, b) => (a.vmid ?? 0) - (b.vmid ?? 0))
      .forEach((r) => {
        cards.push({
          id: `${r.type}/${r.vmid}`,
          kind: 'guest',
          type: r.type, // 'lxc' | 'qemu'
          vmid: r.vmid,
          name: r.name ?? `#${r.vmid}`,
          status: r.status ?? 'unknown',
          cpu: r.cpu ?? 0,
          cpuMax: r.maxcpu ?? 1,
          mem: r.mem ?? null,
          memMax: r.maxmem ?? null,
          uptime: r.uptime ?? 0,
        });
      });
  } catch (e) {
    cards.push({ id: 'guests', kind: 'error', name: 'Guests', status: 'unknown', error: e.message });
  }

  // 3) External cards (NAS, router) via Prometheus
  for (const card of externalCards) {
    const q = card.queries ?? {};
    const [up, cpu, mem, memMax, uptime] = await Promise.all([
      q.up ? promInstant(q.up).catch(() => null) : Promise.resolve(null),
      q.cpu ? promInstant(q.cpu).catch(() => null) : Promise.resolve(null),
      q.mem ? promInstant(q.mem).catch(() => null) : Promise.resolve(null),
      q.memMax ? promInstant(q.memMax).catch(() => null) : Promise.resolve(null),
      q.uptime ? promInstant(q.uptime).catch(() => null) : Promise.resolve(null),
    ]);
    let status = 'unknown';
    if (up === 1) status = 'running';
    else if (up === 0) status = 'stopped';
    cards.push({
      id: card.id,
      kind: 'external',
      type: card.type,
      name: card.name,
      status,
      cpu: cpu ?? null,
      cpuMax: 1,
      mem: mem ?? null,
      memMax: memMax ?? null,
      uptime: uptime ?? null,
      grafana: card.grafana ?? null,
    });
  }

  res.set('Cache-Control', 'no-store');
  res.json({ ts: Date.now(), cards });
});

// --- Detail: time series -------------------------------------------------
// Guests: /api/rrd/lxc/205?timeframe=hour   Host: /api/rrd/node?timeframe=hour
app.get('/api/rrd/node', async (req, res) => {
  if (config.demo) return res.json(demoRrd(1));
  const tf = sanitizeTimeframe(req.query.timeframe);
  try {
    const data = await pve(`/nodes/${config.pveNode}/rrddata?timeframe=${tf}&cf=AVERAGE`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/rrd/:type/:vmid', async (req, res) => {
  const { type, vmid } = req.params;
  if (!['lxc', 'qemu'].includes(type) || !/^\d+$/.test(vmid)) {
    return res.status(400).json({ error: 'bad type/vmid' });
  }
  if (config.demo) return res.json(demoRrd((parseInt(vmid, 10) % 5) + 1));
  const tf = sanitizeTimeframe(req.query.timeframe);
  try {
    const data = await pve(
      `/nodes/${config.pveNode}/${type}/${vmid}/rrddata?timeframe=${tf}&cf=AVERAGE`
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Detail: logs from Loki ---------------------------------------------
app.get('/api/logs', async (req, res) => {
  const host = String(req.query.host ?? '').trim();
  if (!host || !/^[\w.\-]+$/.test(host)) {
    return res.status(400).json({ error: 'bad host' });
  }
  if (config.demo) return res.json(demoLogs(host));
  const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 500);
  const logql = `{${config.lokiLabel}="${host}"}`;
  try {
    const lines = await lokiRange(logql, { limit });
    res.json({ query: logql, lines });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Optional: proxy Grafana so panels can be embedded from one origin ---
if (config.grafanaUrl) {
  app.use(
    '/grafana',
    createProxyMiddleware({
      target: config.grafanaUrl,
      changeOrigin: true,
      secure: false,
      ws: true,
      pathRewrite: { '^/grafana': '' },
    })
  );
}

// --- Static frontend -----------------------------------------------------
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));

function sanitizeTimeframe(tf) {
  return ['hour', 'day', 'week', 'month', 'year'].includes(tf) ? tf : 'hour';
}

app.listen(config.port, () => {
  console.log(`proxmox-gui listening on :${config.port}`);
  console.log(`  PVE      ${config.pveHost}:${config.pvePort} (node ${config.pveNode})`);
  console.log(`  Prom     ${config.promUrl}`);
  console.log(`  Loki     ${config.lokiUrl}`);
  console.log(`  Grafana  ${config.grafanaUrl || '(disabled)'}`);
  if (!config.pveTokenId || !config.pveTokenSecret) {
    console.warn('  ! PVE_TOKEN_ID / PVE_TOKEN_SECRET not set — PVE calls will fail');
  }
});
